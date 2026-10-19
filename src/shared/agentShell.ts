// Shell + Agents : un agent, c'est un shell dont le programme est un harnais.
//
// Le panneau d'agent redessinait le flux JSON de `claude -p` ; on finissait par
// ouvrir l'interface native du harnais dans le terminal, sans rien de ce qu'on
// avait réglé dans le panneau. Ici les deux se rejoignent : on choisit une
// configuration d'agent (harnais, modèle, permission, effort, instructions,
// outils Zyvro), on écrit sa tâche, et ce qui se lance est le harnais dans son
// interface à lui, dans un onglet du terminal, avec TOUT ce qui a été choisi
// traduit en drapeaux natifs.
//
// Ce module est la traduction, et il est pur : les trois côtés l'importent
// (principal, pont, rendu), donc il n'importe ni `electron` ni `node:*`.
// `scripts/check-agent-shells.mjs` l'épingle.
//
// Ce qui casse en silence ici, et que le script vérifie :
//
// 1. **Un drapeau du mode impression** (`-p`, `--output-format`, `exec`) donné à
//    une session interactive : elle répondrait une fois et s'en irait.
// 2. **Une question avalée.** `--mcp-config` et `--allowedTools` de claude sont
//    variadiques : ils mangent le mot qui les suit, donc la tâche, si elle
//    n'est pas séparée par `--`.
// 3. **Une reprise qui n'en est pas une.** `codex resume <id>` est une
//    sous-commande, `claude --resume <id>` un drapeau, et un identifiant mal
//    placé devient le prompt sans qu'aucune erreur ne le dise.
// 4. **Un identifiant venu du disque ou de la fenêtre** qui part sur une ligne
//    de commande : lettres, chiffres, tirets, ou rien.
// 5. **Une permission élargie.** « project » ne doit jamais devenir « yolo », et
//    un niveau inconnu retombe sur le défaut, pas sur le plus permissif.

import { AGENT_KINDS, HARNESSES, isAgentKind, speaksCodex, type AgentKind } from "./harness"
import { DEFAULT_PERMISSION, PERMISSIONS, type Permission } from "./permission"

// ---- l'effort ------------------------------------------------------------------

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof EFFORTS)[number]

/** Les harnais qui prennent un effort de raisonnement à la ligne de commande. */
export function supportsEffort(kind: AgentKind): boolean {
  return kind === "claude" || speaksCodex(kind)
}

/**
 * Ce que codex accepte : `model_reasoning_effort` ne va pas au-dessus de
 * « high » dans la configuration que ce dépôt a relevée ; au-delà on plafonne
 * plutôt que d'envoyer une valeur qu'il refuserait au démarrage.
 */
export function codexEffort(effort: Effort): "low" | "medium" | "high" {
  return effort === "low" || effort === "medium" ? effort : "high"
}

// ---- les configurations d'agent ----------------------------------------------------

/**
 * Une configuration d'agent : tout ce que le panneau demandait avant de lancer
 * un tour, retenu sous un nom.
 */
export type AgentProfile = {
  id: string
  name: string
  kind: AgentKind
  /** Null : le modèle par défaut de la CLI, qui change sans nous prévenir. */
  model: string | null
  permission: Permission
  effort: Effort | null
  /** Ajouté au prompt système (claude, qwen) ou à la première tâche (codex, mimo). */
  instructions: string
  /** Brancher les serveurs MCP de ce projet (workflows, capture). */
  mcp: boolean
  /** Fournir le catalogue de skills (le plugin « Advanced skills »). */
  skills: boolean
}

export const MAX_PROFILES = 24
const MAX_NAME = 60
const MAX_INSTRUCTIONS = 8000
const MAX_MODEL = 256
const MAX_PROMPT = 40_000

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function permissionOf(value: unknown): Permission {
  return (PERMISSIONS as readonly string[]).includes(value as string) ? (value as Permission) : DEFAULT_PERMISSION
}

function effortOf(value: unknown): Effort | null {
  return (EFFORTS as readonly string[]).includes(value as string) ? (value as Effort) : null
}

function modelOf(value: unknown): string | null {
  const model = typeof value === "string" ? value.trim().slice(0, MAX_MODEL) : ""
  return model || null
}

function idOf(value: unknown, repli: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : repli
}

export function defaultProfile(kind: AgentKind): AgentProfile {
  return {
    id: `default-${kind}`,
    name: kind,
    kind,
    model: null,
    permission: DEFAULT_PERMISSION,
    effort: null,
    instructions: "",
    mcp: true,
    skills: false,
  }
}

/** Un profil par harnais, au départ : choisir et lancer doit marcher sans réglage. */
export const DEFAULT_PROFILES: AgentProfile[] = AGENT_KINDS.map(defaultProfile)

export function sanitizeProfile(raw: unknown): AgentProfile | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (!isAgentKind(r.kind)) return null
  const name = text(r.name, MAX_NAME).trim()
  const kind = r.kind
  return {
    id: idOf(r.id, ""),
    name: name || kind,
    kind,
    model: modelOf(r.model),
    permission: permissionOf(r.permission),
    // L'effort n'a de sens que pour qui le prend ; un profil qui le porte sur
    // un harnais qui l'ignore le garderait pour rien et le montrerait faux.
    effort: supportsEffort(kind) ? effortOf(r.effort) : null,
    instructions: text(r.instructions, MAX_INSTRUCTIONS),
    mcp: r.mcp !== false,
    skills: r.skills === true,
  }
}

/**
 * La liste telle qu'on la relit : les entrées sans identifiant en reçoivent un,
 * les doublons sont écartés, et une liste vide ou abîmée redonne les défauts.
 */
export function sanitizeProfiles(raw: unknown): AgentProfile[] {
  if (!Array.isArray(raw)) return DEFAULT_PROFILES
  const seen = new Set<string>()
  const out: AgentProfile[] = []
  for (const item of raw) {
    const profile = sanitizeProfile(item)
    if (!profile) continue
    let id = profile.id
    if (!id || seen.has(id)) {
      let n = out.length + 1
      while (seen.has(`profile-${n}`)) n++
      id = `profile-${n}`
    }
    seen.add(id)
    out.push({ ...profile, id })
    if (out.length >= MAX_PROFILES) break
  }
  return out.length > 0 ? out : DEFAULT_PROFILES
}

// ---- ce que la fenêtre demande -----------------------------------------------------

/** Une demande de shell d'agent, telle que la fenêtre l'envoie : du texte jusqu'à preuve du contraire. */
export type NativeSpec = {
  kind: AgentKind
  model: string | null
  permission: Permission
  effort: Effort | null
  instructions: string
  mcp: boolean
  skills: boolean
  /** Le nom de l'onglet et de la session ; vide : dérivé de la tâche. */
  name: string
  /** La tâche à donner au harnais en démarrant. Vide : il démarre sur son invite. */
  prompt: string
  profileId: string | null
  /** Un enregistrement à reprendre (sa session, sa configuration). */
  resume: string | null
  /** Un fil du chat dont on continue la session, quand il y en a une. */
  conversation: string | null
  /**
   * Envoyer la tâche d'un coup de plus (Entrée) quand elle est collée dans
   * l'invite. Pour la file de tâches, qui prompte seule ; une tâche écrite à la
   * main reste, elle, à relire avant d'être envoyée.
   */
  submit: boolean
  /**
   * La session dont cet agent prend la suite, quand on change de harnais : un
   * enregistrement dont le principal lit le transcript pour en faire un briefing.
   */
  handoff: string | null
}

export function sanitizeSpec(raw: unknown): NativeSpec | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (!isAgentKind(r.kind)) return null
  const kind = r.kind
  return {
    kind,
    model: modelOf(r.model),
    permission: permissionOf(r.permission),
    effort: supportsEffort(kind) ? effortOf(r.effort) : null,
    instructions: text(r.instructions, MAX_INSTRUCTIONS),
    mcp: r.mcp !== false,
    skills: r.skills === true,
    name: text(r.name, MAX_NAME).replace(/[\r\n\t]+/g, " ").trim(),
    prompt: text(r.prompt, MAX_PROMPT),
    profileId: typeof r.profileId === "string" && r.profileId ? idOf(r.profileId, "") || null : null,
    resume: typeof r.resume === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.resume) ? r.resume : null,
    conversation: typeof r.conversation === "string" && r.conversation ? r.conversation.slice(0, 200) : null,
    submit: r.submit === true,
    handoff: typeof r.handoff === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.handoff) ? r.handoff : null,
  }
}

export function specOfProfile(profile: AgentProfile, prompt = "", name = ""): NativeSpec {
  return {
    kind: profile.kind,
    model: profile.model,
    permission: profile.permission,
    effort: profile.effort,
    instructions: profile.instructions,
    mcp: profile.mcp,
    skills: profile.skills,
    name,
    prompt,
    profileId: profile.id,
    resume: null,
    conversation: null,
    submit: false,
    handoff: null,
  }
}

// ---- les enregistrements de session ------------------------------------------------

/**
 * Une session d'agent natif, gardée sur le disque.
 *
 * Elle porte l'identifiant que le harnais connaît (`sessionId`), c'est ce qui
 * permet de rouvrir la même conversation demain, et la configuration avec
 * laquelle elle a été lancée, parce qu'une session reprise doit retrouver sa
 * permission et son modèle, pas ceux du moment.
 */
export type AgentShellRecord = {
  id: string
  kind: AgentKind
  model: string | null
  permission: Permission
  effort: Effort | null
  instructions: string
  mcp: boolean
  skills: boolean
  name: string
  profileId: string | null
  /** Null tant que le harnais ne l'a pas dit (codex le choisit lui-même). */
  sessionId: string | null
  /** La première tâche, pour reconnaître la session dans une liste. */
  prompt: string
  createdAt: string
  updatedAt: string
  /**
   * « open » : l'onglet était ouvert à la fermeture de l'application, on le
   * rouvre au prochain démarrage. « closed » : fermé à la main ou terminé, la
   * session reste dans la liste et se reprend d'un clic.
   */
  state: "open" | "closed"
}

export const MAX_RECORDS = 200

export function sessionIdOk(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)
}

export function sanitizeRecord(raw: unknown): AgentShellRecord | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const spec = sanitizeSpec(r)
  const id = idOf(r.id, "")
  if (!spec || !id) return null
  const date = (value: unknown): string => {
    const t = typeof value === "string" ? Date.parse(value) : NaN
    return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString()
  }
  return {
    id,
    kind: spec.kind,
    model: spec.model,
    permission: spec.permission,
    effort: spec.effort,
    instructions: spec.instructions,
    mcp: spec.mcp,
    skills: spec.skills,
    name: spec.name,
    profileId: spec.profileId,
    sessionId: sessionIdOk(r.sessionId) ? r.sessionId : null,
    prompt: spec.prompt,
    createdAt: date(r.createdAt),
    updatedAt: date(r.updatedAt),
    state: r.state === "open" ? "open" : "closed",
  }
}

export function sanitizeRecords(raw: unknown): AgentShellRecord[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: AgentShellRecord[] = []
  for (const item of raw) {
    const record = sanitizeRecord(item)
    if (!record || seen.has(record.id)) continue
    seen.add(record.id)
    out.push(record)
  }
  return out
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_RECORDS)
}

/** Le nom d'une session : celui qu'on a donné, sinon le début de la tâche, sinon le harnais. */
export function recordTitle(record: Pick<AgentShellRecord, "name" | "prompt" | "kind" | "model">): string {
  if (record.name.trim()) return record.name.trim()
  const line = record.prompt.trim().split("\n").find((l) => l.trim()) ?? ""
  const clean = line.trim().replace(/\s+/g, " ")
  if (clean) return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
  return record.model ? `${record.kind} · ${record.model}` : record.kind
}

/** Les sessions à rouvrir au démarrage : celles qui étaient ouvertes, hors celles déjà vivantes. */
export function toRestore(records: AgentShellRecord[], live: ReadonlySet<string>, max = 6): AgentShellRecord[] {
  return records
    .filter((record) => record.state === "open" && !live.has(record.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, Math.max(0, max))
}

// ---- la ligne de commande -----------------------------------------------------------

/**
 * Comment le harnais reçoit sa tâche : sur la ligne de commande (`argv`), ou
 * collée dans son invite une fois qu'il est prêt (`paste`).
 *
 * Seuls claude et codex ont un mot positionnel relevé sur le binaire. Pour les
 * autres, un drapeau de prompt deviné qui n'existe pas ferait quitter le
 * programme avec « unknown option » : on colle la tâche dans l'invite, sans
 * valider, ce qui marche pour tous et ne peut pas casser un démarrage.
 */
export function promptDelivery(kind: AgentKind): "argv" | "paste" {
  return kind === "claude" || speaksCodex(kind) ? "argv" : "paste"
}

/** Peut-il recevoir un prompt système à part ? Sinon il est préfixé à la tâche. */
export function hasSystemPromptFlag(kind: AgentKind): boolean {
  return HARNESSES[kind].envelope === "claude"
}

/**
 * La permission, dite au harnais en mode interactif.
 *
 * Ce n'est pas celle du mode impression (`agent.ts`) : là, personne ne peut
 * répondre, donc ce qui demanderait est refusé d'avance. Ici la CLI a son
 * interface, et « Ask » veut dire qu'elle demande, à l'écran, dans le terminal.
 */
export function nativePermission(kind: AgentKind, permission: Permission): string[] {
  if (kind === "claude") {
    switch (permission) {
      case "read":
        // Le mode plan : lit, cherche, propose, n'écrit ni n'exécute rien.
        return ["--permission-mode", "plan"]
      case "ask":
        return ["--permission-mode", "manual"]
      case "yolo":
        return ["--permission-mode=bypassPermissions", "--allow-dangerously-skip-permissions"]
      default:
        // acceptEdits est celui qui tient la promesse « rien ne sort du projet »
        // (voir claudePermission dans agent.ts, qui l'a mesuré).
        return ["--permission-mode", "acceptEdits"]
    }
  }
  if (speaksCodex(kind)) {
    switch (permission) {
      case "read":
        return ["-c", "sandbox_mode=read-only", "-c", "approval_policy=on-request"]
      case "ask":
        return ["-c", "sandbox_mode=workspace-write", "-c", "approval_policy=untrusted"]
      case "yolo":
        return ["--dangerously-bypass-approvals-and-sandbox"]
      default:
        return ["-c", "sandbox_mode=workspace-write", "-c", "approval_policy=never"]
    }
  }
  if (kind === "qwen") {
    switch (permission) {
      case "read":
        return ["--approval-mode", "plan"]
      case "ask":
        return ["--approval-mode", "default"]
      case "yolo":
        return ["--approval-mode", "yolo"]
      default:
        return ["--approval-mode", "auto-edit"]
    }
  }
  // mimo
  switch (permission) {
    case "read":
      return ["--agent", "plan"]
    case "yolo":
      // `--trust` : ne pas s'arrêter sur « faites-vous confiance à ce dossier ? »
      // — l'onglet a été ouvert dans le projet, c'est déjà une réponse.
      return ["--dangerously-skip-permissions", "--trust"]
    default:
      return []
  }
}

export type NativeInput = {
  kind: AgentKind
  model: string | null
  permission: Permission
  effort: Effort | null
  name: string
  /**
   * L'identifiant à reprendre, ou — pour claude seulement — à attribuer à une
   * session neuve (`assign`). Vérifié ici : il part sur une ligne de commande.
   */
  sessionId: string | null
  assign: boolean
  /** Le prompt système, quand le harnais en prend un. */
  systemPrompt: string
  /** Les drapeaux qui branchent les serveurs MCP, déjà composés par le principal. */
  mcpArgs: string[]
  /** Les drapeaux qui visent un fournisseur (qwen, codex), déjà composés. */
  aimArgs: string[]
  /** La tâche, quand elle voyage sur la ligne de commande. */
  prompt: string
}

/**
 * Les arguments du harnais, dans l'ordre où il les veut.
 *
 * La tâche est toujours le dernier mot, et séparée par `--` pour claude : ses
 * options variadiques (`--mcp-config`, `--allowedTools`) avalent sinon le mot
 * qui les suit.
 */
export function nativeArgs(input: NativeInput): string[] {
  const { kind } = input
  const model = input.model?.trim() ? input.model.trim() : null
  const id = sessionIdOk(input.sessionId) ? input.sessionId : null
  const prompt = input.prompt
  const args: string[] = []

  if (kind === "claude") {
    args.push(...nativePermission(kind, input.permission))
    if (model) args.push("--model", model)
    if (input.effort) args.push("--effort", input.effort)
    if (input.name) args.push("--name", input.name)
    if (id) args.push(input.assign ? "--session-id" : "--resume", id)
    if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt)
    args.push(...input.mcpArgs)
    if (prompt) args.push("--", prompt)
    return args
  }

  if (speaksCodex(kind)) {
    // `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` : la sous-commande d'abord,
    // les options ensuite, l'identifiant puis la tâche.
    if (id && !input.assign) args.push("resume")
    args.push(...nativePermission(kind, input.permission))
    if (input.effort) args.push("-c", `model_reasoning_effort=${codexEffort(input.effort)}`)
    args.push(...input.aimArgs)
    if (model) args.push("--model", model)
    args.push(...input.mcpArgs)
    if (id && !input.assign) args.push(id)
    if (prompt) args.push(...(prompt.startsWith("-") ? ["--"] : []), prompt)
    return args
  }

  if (kind === "qwen") {
    args.push(...nativePermission(kind, input.permission))
    if (input.aimArgs.length > 0) args.push(...input.aimArgs)
    else if (model) args.push("-m", model)
    if (id && !input.assign) args.push("--resume", id)
    if (input.systemPrompt) args.push("--append-system-prompt", input.systemPrompt)
    args.push(...input.mcpArgs)
    return args
  }

  // mimo
  args.push(...nativePermission(kind, input.permission))
  if (model) args.push("--model", model)
  if (id && !input.assign) args.push("--session", id)
  args.push(...input.mcpArgs)
  return args
}

/**
 * La tâche telle que le harnais la reçoit, qu'elle voyage en argument ou soit
 * collée : le préambule d'abord s'il n'a pas de prompt système à lui.
 */
export function taskText(kind: AgentKind, preface: string, prompt: string): string {
  if (!prompt) return ""
  return hasSystemPromptFlag(kind) || !preface ? prompt : `${preface}\n\n---\n\n${prompt}`
}

/** Les mots qui désignent le texte collé : jamais une séquence qui sortirait du collage. */
export function bracketedPaste(value: string): string {
  // Une fin de collage glissée dans le texte laisserait le reste être TAPÉ,
  // retours à la ligne compris : la tâche serait envoyée avant d'être relue.
  return `\x1b[200~${value.replace(/\x1b\[20[01]~/g, "").replace(/\r\n?/g, "\n")}\x1b[201~`
}

// ---- retrouver la session de codex ----------------------------------------------------

/**
 * Codex choisit lui-même l'identifiant de sa session et l'écrit en tête d'un
 * journal `rollout-<date>-<id>.jsonl` : la première ligne est un
 * `session_meta` qui porte `id` et `cwd`. On le lit pour savoir quoi reprendre.
 * Pur : on lui donne la première ligne.
 */
export function codexSessionFromMeta(firstLine: string, cwd: string): string | null {
  try {
    const meta = JSON.parse(firstLine) as { type?: string; payload?: { id?: unknown; cwd?: unknown } }
    const payload = meta.type === "session_meta" ? meta.payload : (meta as { id?: unknown; cwd?: unknown })
    if (!payload) return null
    const id = payload.id
    const dir = payload.cwd
    if (!sessionIdOk(id)) return null
    if (typeof dir === "string" && normalizeDir(dir) !== normalizeDir(cwd)) return null
    return id
  } catch {
    return null
  }
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

// ---- changer de harnais : reprendre le fil d'une autre session ---------------------------
//
// Une session appartient à son harnais : l'identifiant de claude ne veut rien dire
// pour codex, et un modèle d'un autre fournisseur ne relit pas le journal de la
// première. Changer de harnais n'est donc pas « reprendre », c'est **passer le
// relais** : on lit le transcript de l'ancienne session, on en fait un briefing,
// et le nouvel agent le reçoit en premier message.
//
// Ce module est le lecteur et le rédacteur, purs. Seuls claude et codex ont un
// journal dont le format a été relevé ; les autres donnent un briefing sans
// transcript, qui le dit.

export type Turn = { role: "user" | "assistant" | "tool"; text: string }

const MAX_TURN = 1500
const MAX_TOOL = 140

function clip(text: string, max: number): string {
  const one = text.replace(/\r\n?/g, "\n").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

// Ce qu'un harnais écrit dans son journal sans que ce soit une parole : rappels
// de contexte, commandes locales, instructions du dépôt.
function noise(text: string): boolean {
  const t = text.trimStart()
  return (
    t === "" ||
    t.startsWith("<environment_context>") ||
    t.startsWith("<user_instructions>") ||
    t.startsWith("# AGENTS.md") ||
    t.startsWith("<command-") ||
    t.startsWith("<local-command") ||
    t.startsWith("Caveat:") ||
    t.startsWith("<system-reminder>")
  )
}

function toolLine(name: unknown, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const arg = [args.command, args.cmd, args.file_path, args.path, args.pattern, args.url, args.description].find(
    (v): v is string => typeof v === "string" && v !== ""
  )
  const joined = Array.isArray(args.command) ? args.command.join(" ") : arg
  return clip(`${typeof name === "string" ? name : "tool"}${joined ? `: ${joined}` : ""}`, MAX_TOOL)
}

/** Lire le journal d'une session. Un journal abîmé donne ce qu'on a pu lire, jamais une erreur. */
export function parseTranscript(kind: AgentKind, raw: string): Turn[] {
  const turns: Turn[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let obj: Record<string, any>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj || typeof obj !== "object" || obj.isSidechain === true) continue

    if (kind === "claude") {
      const content = obj.message?.content
      if (obj.type === "user") {
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
              : ""
        if (!noise(text)) turns.push({ role: "user", text: clip(text, MAX_TURN) })
      } else if (obj.type === "assistant" && Array.isArray(content)) {
        const text = content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
        if (text.trim()) turns.push({ role: "assistant", text: clip(text, MAX_TURN) })
        for (const b of content) if (b?.type === "tool_use") turns.push({ role: "tool", text: toolLine(b.name, b.input) })
      }
      continue
    }

    if (speaksCodex(kind)) {
      const payload = obj.type === "response_item" ? obj.payload : obj.type === "message" ? obj : null
      if (!payload) continue
      if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
        const text = (Array.isArray(payload.content) ? payload.content : [])
          .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
          .join("\n")
        if (!noise(text)) turns.push({ role: payload.role, text: clip(text, MAX_TURN) })
      } else if (payload.type === "function_call") {
        let args: unknown = payload.arguments
        if (typeof args === "string") {
          try {
            args = JSON.parse(args)
          } catch {
            args = {}
          }
        }
        turns.push({ role: "tool", text: toolLine(payload.name, args) })
      }
    }
  }
  return turns
}

/**
 * Le briefing que reçoit le nouvel agent.
 *
 * Borné : il voyage en argument ou collé, et un très long fil ne tient pas. On
 * garde la demande d'origine, puis les échanges les plus récents jusqu'au budget,
 * et on dit combien ont été laissés de côté.
 */
export function briefing(input: {
  turns: Turn[]
  from: { kind: AgentKind; model: string | null }
  to: { kind: AgentKind; model: string | null }
  budget?: number
}): string {
  const budget = input.budget ?? 12_000
  const name = (side: { kind: AgentKind; model: string | null }): string => (side.model ? `${side.kind} (${side.model})` : side.kind)
  const head = [
    `You are taking over a working session in this project. It was started with ${name(input.from)}; you are ${name(input.to)}.`,
    "Below is the conversation so far, oldest first, shortened. Continue from where it stopped: do not redo finished work, and do not assume the transcript is complete.",
    "Before changing anything, check the current state of the repository (git status, git diff).",
  ].join("\n")
  const foot =
    "End of the previous conversation. If the last request was already completed, say so briefly and wait for the user's next instruction."

  const format = (turn: Turn): string =>
    turn.role === "tool" ? `  · ${turn.text}` : `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`

  if (input.turns.length === 0) {
    return `${head}\n\nNo transcript could be read for the previous ${input.from.kind} session, so you have only this: ask the user what was being worked on, or read the repository to find out.\n\n${foot}`
  }
  const first = input.turns.find((t) => t.role === "user")
  const rest = input.turns
  const picked: string[] = []
  let used = head.length + foot.length + (first ? first.text.length + 40 : 0)
  let kept = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const line = format(rest[i])
    if (used + line.length > budget) break
    picked.unshift(line)
    used += line.length + 1
    kept++
  }
  const omitted = rest.length - kept
  const start = first && picked[0] !== format(first) ? `Original request:\nUser: ${first.text}\n\n` : ""
  const gap = omitted > 0 ? `[${omitted} earlier message${omitted === 1 ? "" : "s"} omitted]\n` : ""
  return `${head}\n\n${start}${gap}${picked.join("\n")}\n\n${foot}`
}
