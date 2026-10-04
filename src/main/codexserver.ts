// Codex par son serveur d'application, pour pouvoir lui parler en plein tour.
//
// `codex exec` est un aller-retour : la question part, le tour se déroule, le
// processus sort. Rien ne peut l'atteindre entre-temps — `codex queue` y range
// bien un message, mais exec ne le relève qu'à la fin du tour, démarre une
// tâche avec, et sort sans y répondre : le message est consommé et perdu
// (mesuré sur la 0.159.1).
//
// Le serveur d'application (`codex app-server`, JSON-RPC sur stdio) a ce qu'il
// faut : `turn/steer` glisse un message dans le tour en cours, que le modèle
// lit au prochain point d'arrêt — mesuré : envoyé pendant la première de deux
// commandes, la seconde n'a pas été lancée et la réponse a suivi la consigne.
//
// Le reste du panneau lit le flux de `codex exec --json`. Plutôt que d'écrire
// un second lecteur, ce module traduit les notifications du serveur dans ce
// format-là : l'affichage, le transcript et le rejeu ne voient pas la
// différence.

import type { Permission } from "../shared/permission"
import { codexAnswerResult, questionsFromCodex, type AgentQuestion, type QuestionAnswers } from "../shared/questions"

/** Poser des questions à la personne. Null : pas de réponse (refus, délai). */
export type CodexAsk = (questions: AgentQuestion[], signal: AbortSignal) => Promise<QuestionAnswers | null>

// Ce qui rend l'outil de questions de Codex disponible hors du mode plan. Il est
// « under development » en 0.159.1 mais fonctionne — mesuré : la requête arrive
// et la réponse est lue. Sans lui, le routeur répond « request_user_input is
// unavailable in Default mode » et le modèle pose sa question en texte, en
// fin de tour.
//
// Par `-c` et pas par `--enable` : `--enable` d'un nom inconnu fait échouer le
// serveur au démarrage (« Unknown feature flag »), `-c` est ignoré avec un
// avertissement. Le jour où le drapeau disparaît, le panneau continue de
// marcher.
export const CODEX_QUESTIONS_FEATURE = ["-c", "features.default_mode_request_user_input=true"]

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access"

/** La permission du panneau, dans le vocabulaire du serveur. Jamais de question :
 *  comme `codex exec`, un tour du panneau ne peut demander à personne. */
export function codexServerPolicy(permission: Permission): { sandbox: CodexSandbox; approvalPolicy: "never" } {
  switch (permission) {
    case "read":
      return { sandbox: "read-only", approvalPolicy: "never" }
    case "yolo":
      return { sandbox: "danger-full-access", approvalPolicy: "never" }
    default:
      return { sandbox: "workspace-write", approvalPolicy: "never" }
  }
}

/** Ce qu'on donne au modèle : le texte, puis les images par leur chemin. */
export function codexInput(text: string, images: string[] = []): unknown[] {
  return [{ type: "text", text, text_elements: [] }, ...images.map((path) => ({ type: "localImage", path }))]
}

type Usage = { input: number; cached: number; output: number }

/** Ce que la traduction retient d'une notification à l'autre. */
export type TranslateState = {
  /** Les messages de la personne vus dans ce tour : le premier est la question. */
  userMessages: number
  usage: Usage | null
}

export function newTranslateState(): TranslateState {
  return { userMessages: 0, usage: null }
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : ""))
    .join("")
}

/**
 * Une notification du serveur, rendue en événements de `codex exec --json`.
 * Une liste vide pour ce que le panneau n'a pas besoin de voir.
 *
 * Deux événements n'existent pas chez exec, préfixés `zyvro.` :
 *   `zyvro.steered`  un message glissé en plein tour vient d'être pris ;
 *   `zyvro.failed`   le tour a échoué, avec la raison.
 */
export function translateNotification(method: string, params: Record<string, unknown>, state: TranslateState): Record<string, unknown>[] {
  const item = (params.item ?? {}) as Record<string, unknown>
  const kind = item.type
  if (method === "turn/started") return [{ type: "turn.started" }]

  if (method === "item/started" || method === "item/completed") {
    const phase = method === "item/started" ? "item.started" : "item.completed"
    if (kind === "userMessage") {
      if (method !== "item/completed") return []
      state.userMessages++
      // Le premier est la question du tour ; les suivants ont été glissés.
      if (state.userMessages === 1) return []
      return [{ type: "zyvro.steered", text: textOfContent(item.content) }]
    }
    if (kind === "commandExecution") {
      return [
        {
          type: phase,
          item: {
            id: item.id,
            type: "command_execution",
            command: item.command,
            aggregated_output: item.aggregatedOutput ?? "",
            output: item.aggregatedOutput ?? "",
            exit_code: item.exitCode ?? null,
            status: item.status,
          },
        },
      ]
    }
    if (kind === "agentMessage" && method === "item/completed") {
      return [{ type: phase, item: { id: item.id, type: "agent_message", text: item.text ?? "" } }]
    }
    if (kind === "reasoning" && method === "item/completed") {
      const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
      return [{ type: phase, item: { id: item.id, type: "reasoning", text: parts.map(String).join("\n") } }]
    }
    if (kind === "fileChange") {
      return [{ type: phase, item: { id: item.id, type: "file_change", changes: item.changes ?? [], status: item.status } }]
    }
    if (kind === "mcpToolCall") {
      return [
        {
          type: phase,
          item: {
            id: item.id,
            type: "mcp_tool_call",
            server: item.server,
            tool: item.tool,
            arguments: item.arguments,
            result: item.result ?? null,
            error: item.error ?? null,
            status: item.status,
          },
        },
      ]
    }
    if (kind === "webSearch") {
      return [{ type: phase, item: { id: item.id, type: "web_search", query: item.query ?? "" } }]
    }
    return []
  }

  if (method === "thread/tokenUsage/updated") {
    const usage = (params.tokenUsage ?? {}) as { last?: Record<string, unknown> }
    const last = usage.last ?? {}
    // Une notification par requête au modèle : la fenêtre se lit sur la
    // dernière, la sortie s'additionne sur le tour.
    state.usage = {
      input: n(last.inputTokens),
      cached: n(last.cachedInputTokens),
      output: (state.usage?.output ?? 0) + n(last.outputTokens),
    }
    return []
  }

  if (method === "turn/completed") {
    const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null }
    if (turn.status === "failed") {
      return [{ type: "zyvro.failed", message: turn.error?.message || "Codex could not finish this turn." }]
    }
    const u = state.usage
    return [
      {
        type: "turn.completed",
        usage: u ? { input_tokens: u.input, cached_input_tokens: Math.min(u.cached, u.input), output_tokens: u.output } : {},
      },
    ]
  }

  if (method === "error") {
    const err = (params.error ?? {}) as { message?: string }
    // Une erreur que le serveur va retenter n'en est pas encore une.
    if (params.willRetry === true) return []
    return [{ type: "zyvro.failed", message: err.message || "Codex reported an error." }]
  }
  return []
}

type Pending = { resolve: (value: { result?: unknown; error?: { message?: string } }) => void }

/**
 * Le dialogue avec un `codex app-server` lancé pour un tour.
 *
 * `write` écrit une ligne sur son entrée, `emit` reçoit les événements au
 * format exec, `finish` ferme son entrée quand le tour est terminé.
 */
export class CodexServerTurn {
  private next = 0
  private pending = new Map<number, Pending>()
  /** Les questions du serveur qui attendent la personne, par id de requête. */
  private asking = new Map<number | string, AbortController>()
  private state = newTranslateState()
  private threadId: string | null = null
  private turnId: string | null = null
  private over = false

  constructor(
    private readonly write: (line: string) => void,
    private readonly emit: (event: Record<string, unknown>) => void,
    private readonly finish: () => void,
    private readonly ask?: CodexAsk
  ) {}

  private request(method: string, params: unknown): Promise<{ result?: unknown; error?: { message?: string } }> {
    return new Promise((resolve) => {
      const id = ++this.next
      this.pending.set(id, { resolve })
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }

  private fail(message: string): void {
    if (this.over) return
    this.over = true
    this.emit({ type: "zyvro.failed", message })
    this.finish()
  }

  /** Ouvrir (ou reprendre) le fil, puis lancer le tour. */
  async start(options: {
    cwd: string
    model: string | null
    sandbox: CodexSandbox
    approvalPolicy: "never"
    resume: string | null
    input: unknown[]
  }): Promise<void> {
    // `experimentalApi` : `item/tool/requestUserInput` en fait partie.
    const init = await this.request("initialize", { clientInfo: { name: "zyvro-studio", version: "1" }, capabilities: { experimentalApi: true } })
    if (init.error) return this.fail(`Codex app server: ${init.error.message ?? "initialize failed"}`)
    this.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }))

    const common = { cwd: options.cwd, sandbox: options.sandbox, approvalPolicy: options.approvalPolicy, ...(options.model ? { model: options.model } : {}) }
    const opened = options.resume
      ? await this.request("thread/resume", { threadId: options.resume, ...common, excludeTurns: true })
      : await this.request("thread/start", common)
    if (opened.error) return this.fail(opened.error.message ?? "Codex could not open the conversation.")
    const thread = (opened.result as { thread?: { id?: string } } | undefined)?.thread
    this.threadId = thread?.id ?? options.resume
    if (this.threadId) this.emit({ type: "thread.started", thread_id: this.threadId })

    const started = await this.request("turn/start", { threadId: this.threadId, input: options.input })
    if (started.error) return this.fail(started.error.message ?? "Codex could not start the turn.")
    this.turnId = (started.result as { turn?: { id?: string } } | undefined)?.turn?.id ?? this.turnId
  }

  /**
   * Glisser un message dans le tour en cours. Rend faux quand ce n'est plus
   * possible — pas de tour, tour fini, refus du serveur — et l'appelant le
   * remet alors dans la file, pour le tour suivant.
   */
  async steer(text: string): Promise<boolean> {
    if (this.over || !this.threadId || !this.turnId) return false
    const answer = await this.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: codexInput(text),
    })
    return !answer.error
  }

  /** Une ligne de la sortie du serveur. */
  onLine(line: string): void {
    let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message.id === "number" && !message.method) {
      const waiting = this.pending.get(message.id)
      if (waiting) {
        this.pending.delete(message.id)
        waiting.resolve({ result: message.result, error: message.error })
      }
      return
    }
    if (message.id !== undefined && message.method) {
      // Une question de l'agent : elle monte au panneau, la réponse redescend.
      if (message.method === "item/tool/requestUserInput" && this.ask) {
        void this.answer(message.id, message.params ?? {})
        return
      }
      // Une autre demande du serveur (une approbation) : le panneau n'en
      // demande aucune en plein tour, donc on refuse plutôt que de le laisser
      // attendre une réponse qui ne viendrait pas.
      this.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported by Zyvro Studio" } }))
      return
    }
    if (!message.method) return
    const params = message.params ?? {}
    // Le serveur a réglé une requête sans nous — le tour a été interrompu : la
    // question quitte l'écran.
    if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId as number | string | undefined
      if (requestId !== undefined) this.asking.get(requestId)?.abort()
    }
    if (message.method === "turn/started") {
      const id = (params.turn as { id?: string } | undefined)?.id
      if (id) this.turnId = id
    }
    for (const event of translateNotification(message.method, params, this.state)) this.emit(event)
    if (message.method === "turn/completed" && !this.over) {
      this.over = true
      this.finish()
    }
  }

  /**
   * Une question du serveur, posée à la personne.
   *
   * La réponse est indexée par l'id de chaque question, toujours en liste.
   * Sans réponse (refus, délai), des listes vides : le modèle lit qu'on n'a
   * rien répondu et continue, au lieu d'attendre.
   */
  private async answer(requestId: number | string, params: Record<string, unknown>): Promise<void> {
    const questions = questionsFromCodex(params)
    const controller = new AbortController()
    this.asking.set(requestId, controller)
    const answers = questions.length > 0 && this.ask ? await this.ask(questions, controller.signal) : null
    this.asking.delete(requestId)
    if (controller.signal.aborted) return
    this.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: codexAnswerResult(questions, answers ?? {}) }))
  }

  /** Le processus est sorti : ce qui attendait une réponse n'en aura pas. */
  closed(): void {
    for (const controller of this.asking.values()) controller.abort()
    this.asking.clear()
    this.over = true
    for (const waiting of this.pending.values()) waiting.resolve({ error: { message: "The Codex app server stopped." } })
    this.pending.clear()
  }
}
