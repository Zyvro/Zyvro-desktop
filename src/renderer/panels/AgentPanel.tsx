import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUp, Image as ImageIcon, MessageSquarePlus, Paperclip, Square, X } from "lucide-react"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { AgentKind, Spent, WorkflowRef } from "../../preload"
import { droppedText, insertAt } from "../../shared/dropped"
import { compact, detail, subscribeUsage, usageShown } from "~/lib/usage"
import { carriesPaths, droppedPaths } from "~/state/dropped"
import { permissionFor, setPermissionFor, subscribePermission } from "~/state/permission"
import { useWorkspace } from "../state/workspace"
import { ModelPicker } from "~/panels/ModelPicker"
import { PermissionPicker } from "~/panels/PermissionPicker"
import { ToolRow, type ToolCall } from "~/panels/ToolRow"
import type { StoredTool } from "../../preload"

// This panel runs the agent CLI that is already signed in on this machine, so
// the streaming arrives as IPC events rather than as a fetch. Those events are
// a subscription, which means a module-level store read through
// useSyncExternalStore — not an effect, and not component state poked from a
// listener.

export type ChatRole = "user" | "assistant"

// Un morceau de message : ce que l'agent a dit, ou ce qu'il a fait.
//
// Une seule liste, et dans l'ordre d'arrivée. Le panneau en tenait deux — le
// texte d'un côté, les outils de l'autre — et les affichait l'une après
// l'autre : tous les appels d'outil en haut, toute la prose en dessous. Quand
// l'agent parle, appelle un outil, puis reparle, l'écran montrait l'outil
// d'abord et les deux phrases collées après, dans un ordre que personne n'a
// vécu. L'ordre n'était pas perdu à l'affichage mais à l'écriture, donc aucune
// mise en forme ne pouvait le rattraper.
export type Part = { kind: "text"; text: string } | { kind: "tool"; call: ToolCall }

export type ChatMessage = {
  id: string
  role: ChatRole
  parts: Part[]
  error?: string
  streaming: boolean
  // Ce que le tour a dépensé, tel que le CLI le rapporte à la fin. Hors des
  // morceaux : ce n'est pas une chose que l'agent a dite ou faite, c'est un
  // reçu sur le tour entier.
  spent?: Spent
}

// textOf : tout ce que le message a dit, sans ce qu'il a fait.
//
// Pour ce qui n'a pas besoin de l'ordre — la sauvegarde d'un message
// d'utilisateur, le titre d'un onglet, savoir si quelque chose a été dit.
export function textOf(message: ChatMessage): string {
  return message.parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("")
}

export function toolsOf(message: ChatMessage): ToolCall[] {
  return message.parts
    .filter((part): part is { kind: "tool"; call: ToolCall } => part.kind === "tool")
    .map((part) => part.call)
}

// addText ajoute au dernier morceau parlé, ou en ouvre un nouveau.
//
// Ouvrir un morceau par fragment reçu donnerait des centaines de morceaux pour
// une phrase, et un rendu Markdown par fragment : un paragraphe se réassemble
// tant que rien ne s'est passé entre-temps.
export function addText(parts: Part[], text: string): Part[] {
  const last = parts[parts.length - 1]
  if (last && last.kind === "text") {
    return [...parts.slice(0, -1), { kind: "text", text: last.text + text }]
  }
  return [...parts, { kind: "text", text }]
}

// A thread is one conversation: its own transcript, its own CLI session, its
// own model, and its own turn in flight.
//
// That last one is the point of tabs. A turn started in one tab keeps streaming
// while you read another, so you can set a long job going and carry on. Which
// means `busy` and `turnId` belong to a thread and not to the panel — a single
// pair would have made every tab look busy whenever any of them was, and Stop
// would have killed whichever turn happened to be last.
type Thread = {
  /**
   * The thread's own id, which is what the CLI's session is filed under.
   *
   * Not the CLI's session id: that one is learned from the output of the first
   * turn and lives in the main process. This is ours, it exists before any turn
   * has run, and it is what makes "the conversation the user is looking at" a
   * thing that can be named, saved and reopened.
   */
  id: string
  title: string
  messages: ChatMessage[]
  /** The id main gave us for the turn in flight; Stop needs it. */
  turnId: string | null
  /** True from the moment the user sends, before the turn id is known. */
  busy: boolean
  /** The model this thread is pinned to, or null for the CLI's own choice. */
  model: string | null
  /** What the CLI reported running last, so the picker can name the default. */
  ranWith: string | null
  /** Which CLI this thread is talking to. */
  kind: AgentKind
  /** What has already been written down, so a save can be skipped. */
  saved: string
  /**
   * Images waiting to go with the next message.
   *
   * Ids and names only: the file itself is written by the main process and its
   * path never comes back here. The renderer naming a path is exactly how "here
   * is an image to read" would become a way to read any file on the machine.
   */
  images: { id: string; name: string }[]
}

// Une demande de permission en attente : ce que la CLI veut faire, et les deux
// boutons qui décident. Elle vit au niveau du panneau et non d'une conversation
// parce que c'est la CLI qui la pose, au milieu d'un tour, sans dire lequel.
type Ask = { id: string; tool: string; input: Record<string, unknown> }

type ChatState = {
  threads: Thread[]
  asks: Ask[]
  activeId: string
}

// Events for a turn can reach the renderer before `agent:send` resolves with
// that turn's id, so anything that arrives for an unbound turn is parked here
// and replayed the moment the binding lands.
type Orphan = { parts: Part[]; error: string; done: boolean; spent?: Spent }

const WORKFLOWS_KEY = ["local", "workflows"] as const

function newConversationId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function blankThread(model: string | null = null, kind: AgentKind = "claude"): Thread {
  return {
    id: newConversationId(),
    title: "New chat",
    messages: [],
    turnId: null,
    busy: false,
    model,
    ranWith: null,
    kind,
    saved: "",
    images: [],
  }
}

const first = blankThread()
let state: ChatState = { threads: [first], activeId: first.id, asks: [] }
const subscribers = new Set<() => void>()
// A turn belongs to a thread, not to the panel: events arrive by turn id and
// have to find their way back to the tab that started them, even when that tab
// is not the one on screen.
const turnToMessage = new Map<string, { threadId: string; messageId: string }>()
const orphans = new Map<string, Orphan>()
const cancelled = new Set<string>()

let messageCounter = 0
function nextMessageId(): string {
  messageCounter += 1
  return `m${messageCounter}`
}

// getSnapshot returns the cached state object. Rebuilding it per call would
// make React re-render forever.
function getSnapshot(): ChatState {
  return state
}

function commit(next: ChatState): void {
  state = next
  for (const listener of [...subscribers]) listener()
}

function threadById(id: string): Thread | undefined {
  return state.threads.find((thread) => thread.id === id)
}

function activeThread(): Thread {
  return threadById(state.activeId) ?? state.threads[0]
}

function mapThread(id: string, change: (thread: Thread) => Thread): void {
  let touched = false
  const threads = state.threads.map((thread) => {
    if (thread.id !== id) return thread
    touched = true
    return change(thread)
  })
  if (!touched) return
  commit({ ...state, threads })
}

function mapMessage(threadId: string, messageId: string, change: (message: ChatMessage) => ChatMessage): void {
  mapThread(threadId, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) => (message.id === messageId ? change(message) : message)),
  }))
}

let attached = false

// The IPC listeners are attached once and never removed. Detaching when the
// last subscriber goes would drop the rest of a turn whenever the user hides
// this panel mid-answer, and four permanent listeners cost nothing.
function ensureAttached(): void {
  if (attached) return
  if (typeof window === "undefined" || !window.zyvro) return
  attached = true

  // Une demande de permission : la CLI veut faire quelque chose et attend une
  // réponse. Elle s'ajoute à la file du panneau, et la conversation l'affiche.
  window.zyvro.agent.onPermission((ask) => {
    commit({ ...state, asks: [...state.asks, ask] })
  })

  window.zyvro.agent.onText(({ id, text }) => {
    const bound = turnToMessage.get(id)
    if (bound === undefined) {
      const orphan = orphanFor(id)
      orphan.parts = addText(orphan.parts, text)
      return
    }
    mapMessage(bound.threadId, bound.messageId, (message) => ({ ...message, parts: addText(message.parts, text) }))
  })

  window.zyvro.agent.onTool(({ id, callId, running, done, shape, detail, plan }) => {
    const call: ToolCall = {
      callId,
      running,
      done,
      shape,
      detail,
      plan,
      output: "",
      isError: false,
      finished: false,
    }
    const bound = turnToMessage.get(id)
    if (bound === undefined) {
      const orphan = orphanFor(id)
      orphan.parts = [...orphan.parts, { kind: "tool", call }]
      return
    }
    mapMessage(bound.threadId, bound.messageId, (message) => ({
      ...message,
      parts: [...message.parts, { kind: "tool", call }],
    }))
  })

  // A result is paired by the call's own id and never by arrival: two commands
  // running at once come back in whichever order they finish, which was seen
  // happening in a real stream rather than guessed at.
  window.zyvro.agent.onToolResult(({ id, callId, output, isError }) => {
    const bound = turnToMessage.get(id)
    // Le résultat retrouve son appel par son identifiant, jamais par l'ordre
    // d'arrivée : deux commandes lancées ensemble reviennent dans l'ordre où
    // elles finissent. La place du morceau, elle, ne bouge pas.
    const settle = (parts: Part[]): Part[] =>
      parts.map((part) =>
        part.kind === "tool" && part.call.callId === callId
          ? { kind: "tool", call: { ...part.call, output, isError, finished: true } }
          : part
      )
    if (bound === undefined) {
      const orphan = orphanFor(id)
      orphan.parts = settle(orphan.parts)
      return
    }
    mapMessage(bound.threadId, bound.messageId, (message) => ({ ...message, parts: settle(message.parts) }))
  })

  // The model is reported for the thread that ran it, whichever tab is on
  // screen: a background turn that fell back to a different model should say so
  // in its own tab rather than in the one being read.
  window.zyvro.agent.onModel(({ conversationId, model }) => {
    const thread = threadById(conversationId)
    if (!thread || thread.ranWith === model) return
    mapThread(conversationId, (t) => ({ ...t, ranWith: model }))
  })

  // Le reçu du tour. Il arrive à la fin, avant `done`, et se pose sur le
  // message auquel il appartient — pas sur le fil : deux tours dans le même
  // onglet ont deux dépenses.
  window.zyvro.agent.onUsage(({ id, ...spent }) => {
    const bound = turnToMessage.get(id)
    if (bound === undefined) {
      orphanFor(id).spent = spent
      return
    }
    mapMessage(bound.threadId, bound.messageId, (message) => ({ ...message, spent }))
  })

  window.zyvro.agent.onError(({ id, message }) => {
    // A turn the user stopped exits non-zero, so main reports it as an error.
    // Showing "exited with code null" for a deliberate Stop would be noise.
    if (cancelled.has(id)) {
      finishTurn(id)
      return
    }
    const bound = turnToMessage.get(id)
    if (bound === undefined) {
      orphanFor(id).error = message
      return
    }
    mapMessage(bound.threadId, bound.messageId, (existing) => ({ ...existing, error: message, streaming: false }))
    endTurn(id)
  })

  window.zyvro.agent.onDone(({ id }) => finishTurn(id))
}

function orphanFor(id: string): Orphan {
  let orphan = orphans.get(id)
  if (!orphan) {
    orphan = { parts: [], error: "", done: false }
    orphans.set(id, orphan)
  }
  return orphan
}

function finishTurn(id: string): void {
  const bound = turnToMessage.get(id)
  if (bound === undefined) {
    orphanFor(id).done = true
    return
  }
  mapMessage(bound.threadId, bound.messageId, (message) => ({ ...message, streaming: false }))
  endTurn(id)
}

function endTurn(id: string): void {
  const bound = turnToMessage.get(id)
  turnToMessage.delete(id)
  orphans.delete(id)
  cancelled.delete(id)
  if (!bound) return
  mapThread(bound.threadId, (thread) =>
    thread.turnId === id || thread.busy ? { ...thread, turnId: null, busy: false } : thread
  )
  persist(bound.threadId)
}

// Reloading is driven by the project, not by a component mounting.
//
// A subscription at module level rather than an effect: this project bans
// useEffect, and the question "which project is open" is answered by the
// workspace store, which anything can watch. Opening a project is exactly when
// its conversations become readable, and closing one is when the panel has to
// stop showing somebody else's.
let restoredFor: string | null = null
useWorkspace.subscribe((workspace) => {
  const project = workspace.project?.project ?? null
  if (project === restoredFor) return
  restoredFor = project
  if (!project) {
    resetChat()
    return
  }
  void restore()
})

function subscribe(listener: () => void): () => void {
  ensureAttached()
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

/** Records the prompt and the assistant placeholder, and returns its id. */
function beginTurn(threadId: string, prompt: string, images: string[] = []): string {
  const assistantId = nextMessageId()
  const user: ChatMessage = {
    id: nextMessageId(),
    role: "user",
    // The names go into the transcript so the message still says what was sent
    // once the chips are gone. The files are not kept in the transcript: they
    // live beside the conversation and go when it does.
    parts: [
      {
        kind: "text",
        text:
          images.length > 0
            ? `${prompt}${prompt ? "\n\n" : ""}${images.map((n) => `📎 ${n}`).join("\n")}`
            : prompt,
      },
    ],
    streaming: false,
  }
  const assistant: ChatMessage = {
    id: assistantId,
    role: "assistant",
    parts: [],
    streaming: true,
  }
  mapThread(threadId, (thread) => ({
    ...thread,
    // The tab is named after what was first asked of it, which is what a
    // person recognises in a row of tabs.
    title: thread.messages.length === 0 ? titleFrom(prompt || images[0] || "") : thread.title,
    messages: [...thread.messages, user, assistant],
    turnId: null,
    busy: true,
  }))
  return assistantId
}

function bindTurn(threadId: string, messageId: string, turnId: string): void {
  turnToMessage.set(turnId, { threadId, messageId })
  mapThread(threadId, (thread) => ({ ...thread, turnId }))

  const orphan = orphans.get(turnId)
  if (!orphan) return
  orphans.delete(turnId)
  if (cancelled.has(turnId)) {
    finishTurn(turnId)
    return
  }
  mapMessage(threadId, messageId, (message) => ({
    ...message,
    // Ce qui est arrivé avant que le tour ait un nom arrive maintenant, dans
    // l'ordre où c'est arrivé.
    parts: [...message.parts, ...orphan.parts],
    spent: orphan.spent ?? message.spent,
    error: orphan.error || message.error,
    streaming: !orphan.done && orphan.error === "",
  }))
  if (orphan.done || orphan.error !== "") endTurn(turnId)
}

/** Fails a turn that never reached main at all, so nothing will stream for it. */
function failTurn(threadId: string, messageId: string, message: string): void {
  mapMessage(threadId, messageId, (existing) => ({ ...existing, error: message, streaming: false }))
  mapThread(threadId, (thread) => ({ ...thread, turnId: null, busy: false }))
}

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------

// The transcript is written down after every turn, beside the CLI's session id
// that main holds. Both or neither: a session resumed into an empty panel is an
// assistant that remembers more than its window shows, which is worse than one
// that remembers nothing.
//
// Saved at the end of a turn rather than on every chunk — a save per streamed
// character would be a file write per character.
function persist(threadId: string): void {
  if (typeof window === "undefined" || !window.zyvro) return
  const thread = threadById(threadId)
  if (!thread) return

  const messages = thread.messages
    .filter((m) => textOf(m) !== "" || toolsOf(m).length > 0 || m.error)
    .map((m) => ({
      role: m.role,
      spent: m.spent,
      // L'ordre est ce qu'on écrit : une conversation rouverte demain doit se
      // relire comme elle s'est déroulée.
      parts: m.parts.map((part) =>
        part.kind === "text"
          ? { kind: "text" as const, text: part.text }
          : {
              kind: "tool" as const,
              call: {
                callId: part.call.callId,
                done: part.call.done,
                shape: part.call.shape,
                detail: part.call.detail,
                output: part.call.output,
                isError: part.call.isError,
                plan: part.call.plan,
              },
            }
      ),
      error: m.error,
    }))
  if (messages.length === 0) return

  const stamp = JSON.stringify(messages)
  if (stamp === thread.saved) return
  mapThread(threadId, (t) => ({ ...t, saved: stamp }))

  void window.zyvro.agent.remember({
    id: thread.id,
    kind: thread.kind,
    title: thread.title,
    // Main overwrites this with what the CLI actually reported; sending what we
    // last knew keeps a conversation whose session has not changed intact.
    sessionId: null,
    model: thread.model,
    ranWith: thread.ranWith,
    messages,
    updatedAt: new Date().toISOString(),
  })
}

// titleFrom is deliberately the same rule the main process uses, and it is one
// line, so it is written twice rather than sent across IPC for every keystroke.
// If it ever becomes more than this, it moves and this goes.
function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n").find((l) => l.trim()) ?? ""
  const clean = line.trim().replace(/\s+/g, " ")
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean || "New chat"
}

// restoreParts relit un message, ancien ou nouveau.
//
// `parts` est la forme d'aujourd'hui. Avant elle, un message portait son texte
// d'un côté et ses outils de l'autre, et l'écran les montrait dans cet
// ordre-là : les outils, puis la prose. C'est donc ainsi qu'on relit un
// transcript ancien — pas pour lui inventer un ordre qu'il n'a pas gardé, mais
// pour le rendre tel qu'il a été vu.
export function restoreParts(m: {
  parts?: ({ kind: "text"; text: string } | { kind: "tool"; call: unknown })[]
  text?: string
  tools?: unknown[]
}): Part[] {
  if (Array.isArray(m.parts)) {
    return m.parts.map((part) =>
      part.kind === "text"
        ? { kind: "text" as const, text: part.text }
        : { kind: "tool" as const, call: restoreTool(part.call as Parameters<typeof restoreTool>[0]) }
    )
  }
  const parts: Part[] = (m.tools ?? []).map((call) => ({
    kind: "tool" as const,
    call: restoreTool(call as Parameters<typeof restoreTool>[0]),
  }))
  if (m.text) parts.push({ kind: "text", text: m.text })
  return parts
}

// restore loads this project's conversations back into their tabs.
//
// All of them, in the order the store keeps — most recently touched first —
// because a tab that vanished on restart would be a conversation the agent
// still remembers and the person cannot reach.
export async function restore(): Promise<void> {
  if (typeof window === "undefined" || !window.zyvro) return
  const all = await window.zyvro.agent.conversations()
  const usable = all.filter((c) => c.messages.length > 0)
  if (usable.length === 0) return

  const threads: Thread[] = usable.map((c) => ({
    id: c.id,
    title: c.title || "New chat",
    messages: c.messages.map((m) => ({
      id: nextMessageId(),
      role: m.role,
      parts: restoreParts(m),
      spent: m.spent,
      error: m.error,
      streaming: false,
    })),
    turnId: null,
    busy: false,
    model: c.model ?? null,
    ranWith: c.ranWith ?? null,
    kind: c.kind,
    images: [],
    // L'empreinte de ce qui est sur le disque, dans la forme où on l'écrirait :
    // sans ça, le premier tour réécrirait un transcript identique.
    saved: "",
  }))
  commit({ threads, activeId: threads[0].id, asks: state.asks })
}

// AskCard : ce que l'agent veut faire, et les deux boutons.
//
// Elle montre l'outil et son argument principal — la commande, le chemin —
// parce que « claude veut utiliser Bash » ne dit rien qu'on puisse approuver.
// Ce qu'on approuve, c'est `rm -rf build`, ou `npm test`.
function AskCard({ ask }: { ask: Ask }): JSX.Element {
  return (
    <div className="mb-1.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-amber-200">{ask.tool}</span>
        <span className="text-[10px] uppercase tracking-wider text-amber-200/70">wants permission</span>
      </div>
      {summarise(ask.input) && (
        <pre className="zy-scroll mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
          {summarise(ask.input)}
        </pre>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => answerAsk(ask.id, true)}
          className="rounded-md bg-amber-400/90 px-2.5 py-1 text-[12px] font-medium text-black hover:bg-amber-300"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={() => answerAsk(ask.id, false)}
          className="rounded-md border border-white/[0.12] px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

// summarise : ce qu'il y a d'intéressant dans l'argument d'un outil.
//
// Une commande, un chemin, une requête — la valeur qu'on lirait en premier. Le
// reste du JSON en dessous n'aide pas à décider, et le cacher rend la question
// lisible d'un coup d'œil.
function summarise(input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "path", "url", "pattern", "query", "prompt"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 600)
  }
  const text = JSON.stringify(input)
  return text === "{}" ? "" : text.slice(0, 600)
}

// restoreTool reads a stored call back, in either of the two shapes the file
// may hold.
function restoreTool(stored: StoredTool | string): ToolCall {
  if (typeof stored === "string") {
    return { callId: stored, running: stored, done: stored, shape: "other", detail: "", plan: [], output: "", isError: false, finished: true }
  }
  return {
    callId: stored.callId,
    running: stored.done,
    done: stored.done,
    shape: (stored.shape as ToolCall["shape"]) ?? "other",
    detail: stored.detail ?? "",
    plan: stored.plan ?? [],
    output: stored.output ?? "",
    isError: Boolean(stored.isError),
    finished: true,
  }
}

function setModel(threadId: string, model: string | null): void {
  mapThread(threadId, (thread) => ({ ...thread, model }))
}

// attach writes one image and hangs a chip on the composer. The file is the
// main process's business; what comes back is what a chip needs to draw itself.
async function attach(threadId: string, name: string, bytes: Uint8Array): Promise<void> {
  const kept = await window.zyvro.agent.attach(threadId, name, bytes)
  mapThread(threadId, (thread) => ({ ...thread, images: [...thread.images, { id: kept.id, name: kept.name }] }))
}

function detach(threadId: string, id: string): void {
  void window.zyvro.agent.detach(threadId, id)
  mapThread(threadId, (thread) => ({ ...thread, images: thread.images.filter((i) => i.id !== id) }))
}

function setKind(threadId: string, kind: AgentKind): void {
  mapThread(threadId, (thread) => ({ ...thread, kind }))
}

// answerAsk : la réponse part, la demande quitte l'écran. Les deux ensemble,
// sinon on peut cliquer deux fois sur « Allow » et la seconde réponse n'a plus
// personne à qui parler.
function answerAsk(id: string, allow: boolean): void {
  commit({ ...state, asks: state.asks.filter((ask) => ask.id !== id) })
  void window.zyvro.agent.answerPermission(id, allow)
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

// A new tab is a new conversation id, which is what makes it a new session: its
// first turn finds nothing to resume and the CLI starts fresh.
//
// The model pin carries over from the tab you were on, because somebody who
// deliberately moved to a slower model does not want the next question silently
// back on the fast one. What the CLI last ran does not carry over — that is a
// fact about a conversation, not about the person.
function openThread(): void {
  const current = activeThread()
  const thread = blankThread(current?.model ?? null, current?.kind ?? "claude")
  commit({ threads: [...state.threads, thread], activeId: thread.id, asks: state.asks })
}

function selectThread(id: string): void {
  if (threadById(id)) commit({ ...state, activeId: id })
}

// Closing a tab stops its turn and forgets its session. Leaving the session
// behind would keep a conversation alive on disk that nothing can reach, and
// the CLI would go on holding it too.
function closeThread(id: string): void {
  const thread = threadById(id)
  if (!thread) return
  if (thread.turnId) {
    markCancelled(thread.turnId)
    void window.zyvro.agent.cancel(thread.turnId)
  }
  void window.zyvro.agent.forget(id)

  const index = state.threads.findIndex((t) => t.id === id)
  const threads = state.threads.filter((t) => t.id !== id)
  if (threads.length === 0) {
    const fresh = blankThread(thread.model, thread.kind)
    commit({ threads: [fresh], activeId: fresh.id, asks: state.asks })
    return
  }
  // The neighbour on the left, which is what every editor does and what keeps
  // the eye near where it already was.
  const next = threads[Math.min(index, threads.length - 1)]
  commit({ threads, activeId: state.activeId === id ? next.id : state.activeId, asks: state.asks })
}

function markCancelled(turnId: string): void {
  cancelled.add(turnId)
}

// Closing the project clears the panel: what is on screen belongs to a project,
// and leaving it there would show one project's conversations over another's.
function resetChat(): void {
  turnToMessage.clear()
  orphans.clear()
  cancelled.clear()
  const fresh = blankThread(activeThread()?.model ?? null, activeThread()?.kind ?? "claude")
  commit({ threads: [fresh], activeId: fresh.id, asks: state.asks })
}

// ---------------------------------------------------------------------------
// Autoscroll
// ---------------------------------------------------------------------------

// Streaming text mutates existing nodes rather than adding them, so a
// MutationObserver watching characterData is what actually catches a chunk
// landing. It stays pinned only while the user is already at the bottom; once
// they scroll up to read, the transcript stops yanking itself down.
function attachAutoscroll(node: HTMLDivElement): () => void {
  const SLACK = 48
  let pinned = true

  const remember = (): void => {
    pinned = node.scrollHeight - node.scrollTop - node.clientHeight <= SLACK
  }
  node.addEventListener("scroll", remember, { passive: true })

  const observer = new MutationObserver(() => {
    if (pinned) node.scrollTop = node.scrollHeight
  })
  observer.observe(node, { childList: true, subtree: true, characterData: true })

  node.scrollTop = node.scrollHeight

  return () => {
    observer.disconnect()
    node.removeEventListener("scroll", remember)
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

const EXAMPLES = [
  "Run the summarize workflow and show me what it wrote.",
  "What does this project's workflow graph do?",
  "Which workflows failed the last time they ran, and why?",
]

const COMPOSER_MAX_HEIGHT = 160

function grow(node: HTMLTextAreaElement): void {
  node.style.height = "0px"
  node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT)}px`
}

export function AgentPanel(): JSX.Element {
  const project = useWorkspace((workspace) => workspace.project)
  const chat = useSyncExternalStore(subscribe, getSnapshot)
  const queryClient = useQueryClient()

  const thread = chat.threads.find((t) => t.id === chat.activeId) ?? chat.threads[0]
  const kind = thread.kind
  const asks = chat.asks
  // Ce que l'agent a le droit de faire appartient au projet, pas à cette
  // conversation : on le choisit en fonction du dossier dans lequel on
  // travaille, et il est encore là demain.
  const projectDir = project?.project ?? null
  const permission = useSyncExternalStore(
    subscribePermission,
    useCallback(() => permissionFor(projectDir), [projectDir])
  )
  // Lu une fois ici plutôt que dans chaque bulle : le réglage est le même pour
  // toute la fenêtre, et cent messages n'ont pas à s'abonner cent fois.
  const showSpent = useSyncExternalStore(subscribeUsage, usageShown, () => true)
  const [draft, setDraft] = useState("")

  const composer = useRef<HTMLTextAreaElement | null>(null)
  const scrollTeardown = useRef<(() => void) | null>(null)

  // React 18 ignores a value returned from a callback ref, so the teardown is
  // held here and run when the ref is called with null.
  const scrollRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) {
      const run = scrollTeardown.current
      scrollTeardown.current = null
      run?.()
      return
    }
    scrollTeardown.current = attachAutoscroll(node)
  }, [])

  // Warms the cache so the first send does not wait on a round trip. The send
  // handler reads the same key, so whichever finishes first is the one used.
  useQuery({
    queryKey: WORKFLOWS_KEY,
    queryFn: () => api.listWorkflows(),
    enabled: project !== null,
  })

  const send = async (prompt: string): Promise<void> => {
    const text = prompt.trim()
    // An image on its own is a message: "what is wrong with this?" is often the
    // whole question, and refusing it because the box is empty would be
    // pedantry.
    if ((text === "" && thread.images.length === 0) || thread.busy || project === null) return
    const threadId = thread.id
    const images = thread.images.map((i) => i.id)

    setDraft("")
    const node = composer.current
    if (node) node.style.height = ""

    const messageId = beginTurn(threadId, text, thread.images.map((i) => i.name))
    // The chips clear with the message they went with: they belong to what was
    // just sent, not to whatever gets typed next.
    mapThread(threadId, (t) => ({ ...t, images: [] }))

    // The workflow list is context, not a precondition. If the local daemon is
    // not answering, the agent should still run — it just will not know the
    // project's workflows by name.
    let workflows: WorkflowRef[] = []
    try {
      const listed = await queryClient.fetchQuery({
        queryKey: WORKFLOWS_KEY,
        queryFn: () => api.listWorkflows(),
      })
      workflows = listed.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description || undefined,
      }))
    } catch {
      workflows = []
    }

    try {
      const turnId = await window.zyvro.agent.send(
        kind,
        text,
        workflows,
        threadId,
        thread.model,
        images,
        permission
      )
      bindTurn(threadId, messageId, turnId)
    } catch (error: unknown) {
      failTurn(threadId, messageId, error instanceof Error ? error.message : String(error))
    }
  }

  const stop = (): void => {
    const turnId = thread.turnId
    if (turnId === null) return
    markCancelled(turnId)
    void window.zyvro.agent.cancel(turnId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void send(draft)
  }

  const useExample = (example: string): void => {
    setDraft(example)
    const node = composer.current
    if (node) {
      node.focus()
      grow(node)
    }
  }

  // Three ways in, which is what Cursor and VS Code both offer: paste, drop,
  // and a button. Paste is the one that matters — a screenshot is usually the
  // shortest way to say what is wrong — and it is also the one that has to
  // distinguish an image on the clipboard from the text beside it.
  const [dropping, setDropping] = useState(false)
  const [attachError, setAttachError] = useState("")

  // insertPaths écrit les chemins déposés là où était le curseur.
  //
  // Un chemin plutôt qu'un contenu : ce qu'on dépose sur un agent qui lit déjà
  // le projet, c'est une désignation — « regarde celui-là ». Le contenu, il
  // sait aller le chercher, et un dossier n'a de toute façon pas de contenu à
  // coller.
  const insertPaths = (paths: string[]): void => {
    const text = droppedText(paths, window.zyvro.platform)
    if (!text) return
    const field = composer.current
    const at = field ? { start: field.selectionStart, end: field.selectionEnd } : { start: draft.length, end: draft.length }
    const next = insertAt(draft, at.start, at.end, text)
    setDraft(next.value)
    // Le curseur derrière ce qu'on vient de coller, et le champ qui reprend la
    // main : on dépose pour continuer à écrire.
    window.requestAnimationFrame(() => {
      if (!field) return
      field.focus()
      field.setSelectionRange(next.cursor, next.cursor)
      grow(field)
    })
  }

  const take = async (files: File[]): Promise<void> => {
    // Une image est jointe — le CLI sait l'ouvrir — et tout le reste, fichier
    // ou dossier, est désigné par son chemin.
    const others = files.filter((file) => !file.type.startsWith("image/"))
    if (others.length > 0) {
      insertPaths(others.map((file) => window.zyvro.files.droppedPath(file)).filter(Boolean))
    }
    const images = files.filter((file) => file.type.startsWith("image/"))
    if (images.length === 0) return
    setAttachError("")
    for (const file of images) {
      try {
        await attach(thread.id, file.name, new Uint8Array(await file.arrayBuffer()))
      } catch (error) {
        setAttachError(error instanceof Error ? error.message : String(error))
      }
    }
  }

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files]
    if (files.length === 0) return
    // Only when there is really an image: a paste of ordinary text also carries
    // an empty file list, and swallowing the event would stop text pasting.
    if (!files.some((file) => file.type.startsWith("image/"))) return
    event.preventDefault()
    void take(files)
  }

  const pick = async (): Promise<void> => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "image/png,image/jpeg,image/gif,image/webp"
    input.multiple = true
    input.onchange = () => void take([...(input.files ?? [])])
    input.click()
  }

  const disabled = project === null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Rien ne doit sortir de cette barre. Le panneau se redimensionne, et le
          nom du modèle est choisi par la CLI — « claude-opus-5[1m] (default) »
          est plus long que « claude-haiku-4-5 ». Sans de quoi rétrécir, c'est
          le bouton de droite qui passait dehors : le seul qui ouvre une
          nouvelle conversation, et il disparaissait sans bruit. */}
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-white/[0.06] px-2">
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">Agent</span>

        <div className="ml-auto min-w-0 max-w-[11rem]">
          <ModelPicker
            kind={kind}
            model={thread.model}
            ranWith={thread.ranWith}
            onChange={(model) => setModel(thread.id, model)}
          />
        </div>

        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.04] p-0.5">
          {(["claude", "codex"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(thread.id, option)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] transition-colors",
                kind === option
                  ? "bg-white/[0.08] text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={openThread}
          title="New conversation"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* One row of tabs, and only when there is more than one: a tab strip
          above a single conversation is furniture. Each tab shows a dot while
          its own turn runs, which is the whole point of having them — a long
          job set going in one tab and read later. */}
      {chat.threads.length > 1 && (
        <div className="zy-tabs flex h-8 shrink-0 items-stretch gap-px overflow-x-auto overflow-y-hidden border-b border-white/[0.06] bg-white/[0.015] px-1">
          {chat.threads.map((t) => (
            <div
              key={t.id}
              className={cn(
                "group flex min-w-0 max-w-[12rem] items-center gap-1 rounded-t px-2 text-[11px]",
                t.id === chat.activeId ? "bg-white/[0.07] text-foreground" : "text-muted-foreground hover:bg-white/[0.04]"
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 text-left"
                title={t.title}
                onClick={() => selectThread(t.id)}
              >
                {t.busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                <span className="truncate">{t.title}</span>
              </button>
              <button
                type="button"
                title="Close this conversation"
                className="shrink-0 rounded p-0.5 opacity-0 hover:bg-white/[0.1] group-hover:opacity-100"
                onClick={() => closeThread(t.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {thread.messages.length === 0 ? (
          <div className="space-y-3 text-xs text-muted-foreground">
            <p className="leading-relaxed">
              This runs the <span className="font-mono text-foreground">{kind}</span> CLI already signed
              in on this machine, in your project directory. A ChatGPT or Claude subscription works here
              with no API key — Zyvro never sees a token.
            </p>
            <p className="leading-relaxed">
              It has this project&apos;s Zyvro tools, so it can list your workflows, read a graph, run
              one and read the result. A run spends your own model account.
            </p>
            <div className="space-y-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => useExample(example)}
                  className="w-full rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-left leading-snug transition-colors hover:bg-white/[0.08] hover:text-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {thread.messages.map((message) => (
              <Bubble key={message.id} message={message} kind={kind} showSpent={showSpent} />
            ))}
          </div>
        )}
      </div>

      <div
        className="shrink-0 border-t border-white/[0.06] p-2"
        onDragOver={(event) => {
          if (!carriesPaths(event)) return
          event.preventDefault()
          setDropping(true)
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          if (!carriesPaths(event)) return
          event.preventDefault()
          setDropping(false)
          // Un fichier venu du Finder peut être une image à joindre ; un
          // fichier venu de l'arbre est toujours une désignation, et il n'y a
          // rien à lire à son sujet — le projet est déjà ouvert.
          const files = [...event.dataTransfer.files]
          if (files.length > 0) {
            void take(files)
            return
          }
          insertPaths(droppedPaths(event))
        }}
      >
        {/* One chip per image, with its name and a cross — the same shape VS
            Code and Cursor use, and for the same reason: an attachment you
            cannot see is one you send by accident. */}
        {thread.images.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {thread.images.map((image) => (
              <span
                key={image.id}
                className="group flex max-w-[14rem] items-center gap-1 rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={image.name}
              >
                <ImageIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{image.name}</span>
                <button
                  type="button"
                  title="Remove"
                  className="shrink-0 rounded p-0.5 hover:bg-white/[0.1] hover:text-foreground"
                  onClick={() => detach(thread.id, image.id)}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Ce que l'agent demande la permission de faire, juste au-dessus de la
            barre de saisie : il attend, et c'est ici qu'on regarde. */}
        {asks.map((ask) => (
          <AskCard key={ask.id} ask={ask} />
        ))}

        {attachError && (
          <p className="mb-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            {attachError}
          </p>
        )}

        {/* Deux rangées : ce qu'on écrit, puis ce qui le gouverne.
            Sur une seule, le sélecteur de droits et le trombone mangeaient la
            moitié d'un panneau large de 360 points — il restait une ligne de
            texte étroite, et les trois hauteurs ne tombaient jamais juste. */}
        <div
          className={cn(
            "rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-2 focus-within:border-white/[0.12]",
            dropping && "border-primary/60 bg-primary/[0.08]"
          )}
        >
          <textarea
            ref={composer}
            rows={1}
            value={draft}
            disabled={disabled}
            placeholder={disabled ? "Open a project first" : `Ask ${kind}…`}
            onChange={(event) => {
              setDraft(event.target.value)
              grow(event.currentTarget)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="block max-h-40 min-h-[22px] w-full resize-none bg-transparent text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />

          <div className="mt-1.5 flex items-center gap-1">
            {/* Ce que l'agent a le droit de faire, sous la question qu'on lui
                pose : c'est là qu'on hésite, et un réglage rangé dans une page
                de préférences est un réglage qu'on découvre en lisant
                « permission refusée » au milieu d'une réponse. */}
            <PermissionPicker
              value={permission}
              kind={kind}
              disabled={disabled}
              onChange={(next) => setPermissionFor(projectDir, next)}
            />
            <button
              type="button"
              title="Attach an image"
              disabled={disabled}
              onClick={() => void pick()}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>

            <span className="flex-1" />

            {thread.busy ? (
              <button
                type="button"
                onClick={stop}
                title="Stop"
                className="shrink-0 rounded-md bg-white/[0.08] p-1.5 text-foreground transition-colors hover:bg-white/[0.12]"
              >
                <Square className="h-3 w-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send(draft)}
                disabled={disabled || draft.trim() === ""}
                title="Send"
                className="shrink-0 rounded-md bg-white/[0.08] p-1.5 text-foreground transition-colors hover:bg-white/[0.12] disabled:opacity-30"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Bubble({
  message,
  kind,
  showSpent,
}: {
  message: ChatMessage
  kind: AgentKind
  showSpent: boolean
}): JSX.Element {
  if (message.role === "user") {
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs leading-relaxed text-foreground">
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">You</div>
        <div className="whitespace-pre-wrap break-words">{textOf(message)}</div>
      </div>
    )
  }

  return (
    <div className="px-0.5 text-xs leading-relaxed">
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{kind}</div>

      {/* Dans l'ordre où c'est arrivé. Il parle, il appelle un outil, il
          reparle — et c'est ce qu'on lit. L'affichage n'a plus rien à décider :
          la liste est déjà dans le bon ordre.

          The assistant writes Markdown, so it is rendered as Markdown. The
          user's own message is left as plain text: they typed it, and reflowing
          their asterisks back at them as emphasis would be wrong. */}
      {message.parts.map((part, index) =>
        part.kind === "tool" ? (
          <div key={`t${part.call.callId}-${index}`} className="my-1 space-y-px">
            <ToolRow call={part.call} />
          </div>
        ) : part.text !== "" ? (
          <Markdown key={`x${index}`} text={part.text} className="text-foreground" compact />
        ) : null
      )}

      {message.streaming && message.parts.length === 0 ? (
        <div className="text-muted-foreground">Thinking…</div>
      ) : null}

      {/* Ce que le tour a dépensé. Discret et sous la réponse : c'est une
          information qu'on va chercher, pas une qu'on subit — et elle
          s'éteint d'un clic dans la barre du bas. */}
      {message.spent && showSpent ? (
        <div
          className="mt-1 font-mono text-[10px] text-muted-foreground/70"
          title={detail(message.spent)}
        >
          ↑ {compact(message.spent.input)} in · ↓ {compact(message.spent.output)} out
        </div>
      ) : null}

      {/* An error is a message, not a crash: the panel keeps working and the
          text usually carries the install hint the user needs. */}
      {message.error !== undefined && message.error !== "" ? (
        <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
          {message.error}
        </div>
      ) : null}
    </div>
  )
}

export default AgentPanel
