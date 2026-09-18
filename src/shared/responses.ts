// Traduire ce que codex parle vers ce que nos serveurs parlent.
//
// codex 0.152.0 ne sait poster que sur l'API **Responses** d'OpenAI :
// `POST /v1/responses`, en flux. Son ancien réglage `wire_api = "chat"` a été
// retiré — « no longer supported, set `wire_api = "responses"` ». Nos
// fournisseurs, eux, parlent Chat Completions : LM Studio, Ollama, tout ce que
// le panneau Fournisseurs sait déjà appeler. Entre les deux il manquait une
// traduction, et c'est la seule raison pour laquelle codex ne pouvait pas viser
// nos modèles quand qwen le pouvait.
//
// Ce module est la traduction, et rien d'autre : pas de serveur, pas de
// réseau. Il se teste en appelant des fonctions.
//
// **Relevé sur le binaire, pas supposé.** Le corps que codex envoie a été
// enregistré en le faisant parler à un serveur qui écrit ce qu'il reçoit :
// `instructions` (16 979 caractères de prompt système), `input` (une liste
// d'objets typés, pas des messages), `tools` à plat — `{type:"function", name,
// description, parameters}` et non `{type:"function", function:{…}}` comme en
// Chat —, plus `reasoning`, `include`, `store`, `prompt_cache_key`,
// `parallel_tool_calls` et `tool_choice`. Les noms d'événements du flux de
// retour ont été trouvés de la même façon : en les envoyant jusqu'à ce qu'un
// vrai tour aille au bout.

/** Ce qui arrive de codex. Du texte jusqu'à preuve du contraire. */
export type ResponsesRequest = Record<string, unknown>

/** Ce qu'on envoie à un serveur Chat Completions. */
export type ChatRequest = {
  model: string
  messages: ChatMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: { type: "function"; function: { name: string; description: string; parameters: unknown } }[]
  tool_choice?: unknown
}

export type ChatMessage = {
  role: string
  content: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function texteDe(valeur: unknown): string {
  return typeof valeur === "string" ? valeur : ""
}

function objet(valeur: unknown): Record<string, unknown> {
  return valeur && typeof valeur === "object" ? (valeur as Record<string, unknown>) : {}
}

// messagesFrom : la liste `input` de Responses devient des messages de Chat.
//
// Trois formes seulement portent du sens ici, et c'est volontaire :
//
//   · `message` — ce que quelqu'un a dit. Le rôle `developer` de Responses est
//     le rôle système de Chat ; le laisser passer tel quel ferait ignorer par
//     le serveur le bloc qui décrit les compétences et le bac à sable.
//   · `function_call` — ce que le modèle a demandé au tour d'avant.
//   · `function_call_output` — ce que codex a exécuté et renvoie.
//
// `reasoning` est écarté : ce sont les jetons de raisonnement chiffrés du
// modèle d'OpenAI (`include: ["reasoning.encrypted_content"]`), que personne
// d'autre ne sait relire. Les renvoyer à un serveur local ne ferait que gonfler
// le contexte d'un opaque qu'il jettera.
export function messagesFrom(body: ResponsesRequest): ChatMessage[] {
  const out: ChatMessage[] = []
  const instructions = texteDe(body.instructions)
  if (instructions) out.push({ role: "system", content: instructions })

  const input = Array.isArray(body.input) ? body.input : []
  for (const brut of input) {
    const item = objet(brut)
    if (item.type === "message") {
      const contenu = Array.isArray(item.content) ? item.content : []
      const texte = contenu.map((c) => texteDe(objet(c).text)).join("")
      const role = item.role === "developer" ? "system" : texteDe(item.role) || "user"
      // Un message vide n'est pas un message : certains serveurs refusent la
      // liste entière à cause d'un seul contenu nul.
      if (texte) out.push({ role, content: texte })
      continue
    }
    if (item.type === "function_call") {
      out.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: texteDe(item.call_id) || texteDe(item.id),
            type: "function",
            function: { name: texteDe(item.name), arguments: texteDe(item.arguments) },
          },
        ],
      })
      continue
    }
    if (item.type === "function_call_output") {
      const sortie = item.output
      out.push({
        role: "tool",
        tool_call_id: texteDe(item.call_id),
        content: typeof sortie === "string" ? sortie : JSON.stringify(sortie ?? ""),
      })
      continue
    }
  }
  return out
}

// toolsFrom : les outils, à plat d'un côté, emboîtés de l'autre.
//
// Et seulement ceux qu'un serveur Chat peut comprendre. codex en déclare de
// trois sortes — `function`, `namespace` (des groupes d'outils propres à son
// écosystème) et `web_search` (exécuté par le dos d'OpenAI). Les deux
// dernières n'ont pas d'équivalent : les traduire en fonctions ferait croire au
// modèle qu'il peut appeler quelque chose qui n'arrivera jamais nulle part.
export function toolsFrom(body: ResponsesRequest): NonNullable<ChatRequest["tools"]> {
  const outils = Array.isArray(body.tools) ? body.tools : []
  const out: NonNullable<ChatRequest["tools"]> = []
  for (const brut of outils) {
    const t = objet(brut)
    if (t.type !== "function") continue
    const name = texteDe(t.name)
    if (!name) continue
    out.push({
      type: "function",
      function: {
        name,
        description: texteDe(t.description),
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    })
  }
  return out
}

/** chatRequestFrom : la requête entière, prête à poster. */
export function chatRequestFrom(body: ResponsesRequest, model: string): ChatRequest {
  const chat: ChatRequest = {
    model,
    messages: messagesFrom(body),
    stream: true,
    // Sans `include_usage`, un flux Chat ne porte aucun compte et le reçu de
    // jetons du panneau afficherait zéro pour un tour qui a coûté. Mesuré :
    // « tokens used 0 » avant, 19 790 après, sur le même tour.
    stream_options: { include_usage: true },
  }
  const outils = toolsFrom(body)
  if (outils.length > 0) {
    chat.tools = outils
    if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice
  }
  return chat
}

// ---- le flux de retour ---------------------------------------------------

/** Un événement du flux Responses, tel qu'il partira sur le fil. */
export type ResponsesEvent = Record<string, unknown> & { type: string }

type Appel = { id: string; itemId: string; name: string; args: string }

/**
 * Translator : l'état d'un tour, du côté qui revient.
 *
 * Un flux Chat est une suite de `delta` ; un flux Responses est une suite
 * d'**items** qui s'ouvrent, se remplissent et se ferment. Passer de l'un à
 * l'autre demande de se souvenir de ce qui est ouvert — d'où une classe plutôt
 * qu'une fonction.
 *
 * Elle ne touche à aucune socket : on lui pousse les objets JSON du flux amont,
 * elle rend les événements à écrire. C'est ce qui permet d'éprouver la
 * traduction entière sans serveur.
 */
export class Translator {
  private readonly responseId: string
  private readonly messageId: string
  private readonly model: string
  private ouvert = false
  private texte = ""
  private index = 0
  /** Les appels d'outils arrivent par morceaux, numérotés par le serveur. */
  private readonly appels = new Map<number, Appel>()
  private usage: Record<string, unknown> | null = null
  private fini = false
  /** Ce qui a été fermé, pour le récapitulatif de `response.completed`. */
  private readonly sortie: Record<string, unknown>[] = []

  constructor(model: string, seed = Date.now().toString(36)) {
    this.model = model
    this.responseId = `resp_${seed}`
    this.messageId = `msg_${seed}`
  }

  /** L'événement d'ouverture. Il part avant tout le reste. */
  created(): ResponsesEvent {
    return {
      type: "response.created",
      response: { id: this.responseId, object: "response", status: "in_progress", model: this.model, output: [] },
    }
  }

  /**
   * push : un objet du flux amont, les événements qu'il produit.
   *
   * Rend une liste parce qu'un seul `delta` en produit parfois trois : le
   * premier morceau de texte ouvre l'item, ouvre la partie, puis écrit.
   */
  push(brut: unknown): ResponsesEvent[] {
    const ev = objet(brut)
    const out: ResponsesEvent[] = []

    // Une erreur qui arrive dans un flux à 200 est le pire des deux silences :
    // sans ça, le tour se termine « réussi » avec zéro caractère et personne ne
    // sait pourquoi. Vu en vrai — LM Studio refusait pour cause de contexte
    // trop court et codex affichait un tour vide.
    const erreur = objet(ev.error)
    if (ev.error !== undefined) {
      this.fini = true
      return [
        {
          type: "response.failed",
          response: {
            id: this.responseId,
            object: "response",
            status: "failed",
            error: { code: "upstream_error", message: texteDe(erreur.message) || JSON.stringify(ev.error) },
          },
        },
      ]
    }

    if (ev.usage) this.usage = objet(ev.usage)

    const choix = Array.isArray(ev.choices) ? objet(ev.choices[0]) : {}
    const delta = objet(choix.delta)

    const contenu = texteDe(delta.content)
    if (contenu !== "") {
      if (!this.ouvert) {
        this.ouvert = true
        out.push({
          type: "response.output_item.added",
          output_index: this.index,
          item: { type: "message", id: this.messageId, role: "assistant", status: "in_progress", content: [] },
        })
        out.push({
          type: "response.content_part.added",
          item_id: this.messageId,
          output_index: this.index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        })
      }
      this.texte += contenu
      out.push({
        type: "response.output_text.delta",
        item_id: this.messageId,
        output_index: this.index,
        content_index: 0,
        delta: contenu,
      })
    }

    const appels = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const bruteforce of appels) {
      const tc = objet(bruteforce)
      const i = typeof tc.index === "number" ? tc.index : 0
      const fonction = objet(tc.function)
      let a = this.appels.get(i)
      if (!a) {
        a = { id: texteDe(tc.id) || `call_${i}_${this.responseId}`, itemId: `fc_${i}_${this.responseId}`, name: "", args: "" }
        this.appels.set(i, a)
      }
      // Le serveur n'envoie l'identifiant et le nom qu'une fois, dans le
      // premier morceau ; les suivants ne portent que des bouts d'arguments.
      if (texteDe(tc.id)) a.id = texteDe(tc.id)
      if (texteDe(fonction.name)) a.name = texteDe(fonction.name)
      a.args += texteDe(fonction.arguments)
    }

    return out
  }

  /** end : ce qui ferme le tour. Appelé quand le flux amont est épuisé. */
  end(): ResponsesEvent[] {
    if (this.fini) return []
    const out: ResponsesEvent[] = []

    if (this.ouvert) {
      const item = {
        type: "message",
        id: this.messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.texte, annotations: [] }],
      }
      out.push({ type: "response.output_text.done", item_id: this.messageId, output_index: this.index, content_index: 0, text: this.texte })
      out.push({
        type: "response.content_part.done",
        item_id: this.messageId,
        output_index: this.index,
        content_index: 0,
        part: { type: "output_text", text: this.texte, annotations: [] },
      })
      out.push({ type: "response.output_item.done", output_index: this.index, item })
      this.sortie.push(item)
      this.index++
    }

    // Les appels d'outils se ferment après le texte, dans l'ordre où le serveur
    // les a numérotés. Ils sont annoncés d'un bloc plutôt que morceau par
    // morceau : on ne les a appris qu'à la fin, et faire semblant de les avoir
    // vus arriver progressivement serait une mise en scène.
    for (const i of [...this.appels.keys()].sort((a, b) => a - b)) {
      const a = this.appels.get(i) as Appel
      const item = { type: "function_call", id: a.itemId, call_id: a.id, name: a.name, arguments: a.args, status: "completed" }
      out.push({ type: "response.output_item.added", output_index: this.index, item: { ...item, status: "in_progress", arguments: "" } })
      out.push({ type: "response.function_call_arguments.delta", item_id: a.itemId, output_index: this.index, delta: a.args })
      out.push({ type: "response.function_call_arguments.done", item_id: a.itemId, output_index: this.index, arguments: a.args })
      out.push({ type: "response.output_item.done", output_index: this.index, item })
      this.sortie.push(item)
      this.index++
    }

    out.push({
      type: "response.completed",
      response: {
        id: this.responseId,
        object: "response",
        status: "completed",
        model: this.model,
        output: this.sortie,
        usage: usageFrom(this.usage),
      },
    })
    return out
  }

  /** A-t-on déjà de quoi écrire ? Sert à ne pas ouvrir la réponse trop tôt. */
  get commence(): boolean {
    return this.ouvert || this.appels.size > 0
  }
}

// usageFrom : les noms changent d'un côté à l'autre, et un compte absent est 0
// plutôt qu'un trou — le reçu du panneau additionne.
function usageFrom(usage: Record<string, unknown> | null): Record<string, number> {
  const n = (valeur: unknown): number => (typeof valeur === "number" && Number.isFinite(valeur) ? valeur : 0)
  return {
    input_tokens: n(usage?.prompt_tokens),
    output_tokens: n(usage?.completion_tokens),
    total_tokens: n(usage?.total_tokens),
  }
}

/** sseLine : un événement, dans la forme qu'un flux SSE attend. */
export function sseLine(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
