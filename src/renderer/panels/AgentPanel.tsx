import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
// L'instance de module : `dispatch` envoie hors de tout composant, donc il ne
// peut pas demander la sienne à un crochet. C'est la même, celle que la
// doctrine impose de tenir ici plutôt que d'en fabriquer une par rendu.
import { queryClient } from "~/lib/queryClient"
import { ArrowUp, Image as ImageIcon, MessageSquarePlus, Paperclip, Repeat, Square, Target, X } from "lucide-react"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { AgentKind, Spent, WorkflowRef } from "../../preload"
import { AGENT_KINDS } from "../../shared/harness"
import { droppedText, insertAt } from "../../shared/dropped"
import { compact, detail, subscribeUsage, usageShown } from "~/lib/usage"
import { carriesPaths, droppedPaths } from "~/state/dropped"
import { permissionFor, setPermissionFor, subscribePermission } from "~/state/permission"
import { useWorkspace } from "../state/workspace"
import { ModelPicker } from "~/panels/ModelPicker"
import { PermissionPicker } from "~/panels/PermissionPicker"
import { ToolRow, type ToolCall } from "~/panels/ToolRow"
import type { Goal, Pending } from "../../preload"
import { Thumb, type Attached } from "~/panels/Thumb"
import { commandsFor, commandsKey, matching, noteCommands, slashPrefix, subscribeCommands } from "~/state/commands"
import { subscribeHandoff, takeHandoff, tokenOf } from "~/state/handoff"
import { engineReady, subscribeEngine } from "~/state/engine"
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
  /** Les images parties avec ce message. Le fichier vit ailleurs ; ceci le nomme. */
  images?: Attached[]
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
  /**
   * Ce que chaque harnais avait épinglé, par son nom.
   *
   * Un modèle appartient au harnais qui l'a proposé, comme une session lui
   * appartient. Vu en basculant : une conversation épinglée sur
   * « ollama-local/qwen2.5:0.5b » passée à claude lui faisait répondre « There's
   * an issue with the selected model » — un nom que claude n'a aucune raison de
   * connaître, gardé parce qu'il vivait sur la conversation et non sur le
   * harnais. Revenir retrouve donc le sien.
   */
  models: Partial<Record<AgentKind, string | null>>
  /** What the CLI reported running last, so the picker can name the default. */
  ranWith: string | null
  /** Which CLI this thread is talking to. */
  kind: AgentKind
  /** Ce vers quoi cette session travaille, tel que le harnais le rapporte. */
  goal: Goal | null
  /** Le rendez-vous que cette session a avec elle-même, quand elle boucle. */
  pending: Pending | null
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
  /**
   * Ce qu'on a tapé pendant qu'un tour tournait, et qui partira tout seul.
   *
   * Sur la conversation et pas sur le panneau, pour la même raison que `busy` :
   * un tour lancé dans un onglet continue pendant qu'on lit un autre, donc une
   * file par panneau enverrait la suite d'une conversation dans une autre.
   */
  queued: Queued[]
}

/** Un message en attente. Il porte ses images : elles ont été choisies avec lui. */
type Queued = { id: string; text: string; images: { id: string; name: string }[] }

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
    models: { [kind]: model },
    goal: null,
    pending: null,
    ranWith: null,
    kind,
    saved: "",
    images: [],
    queued: [],
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
      images: [],
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
  // Ce que le harnais vient d'annoncer savoir faire. Il le dit à l'ouverture de
  // chaque flux ; on le garde pour le menu de la barre oblique.
  window.zyvro.agent.onCommands(({ kind, commands }) => noteCommands(kind, commands))

  // Ce vers quoi la session travaille. `goal: null` efface : il n'y en a plus,
  // ce qui est une nouvelle en soi.
  window.zyvro.agent.onGoal(({ conversationId, goal }) => {
    mapThread(conversationId, (thread) => ({ ...thread, goal }))
  })

  // Une session qui a rendez-vous avec elle-même.
  window.zyvro.agent.onScheduled(({ conversationId, pending }) => {
    mapThread(conversationId, (thread) => ({ ...thread, pending }))
  })

  // Un tour parti tout seul. Il lui faut ses deux bulles comme à n'importe quel
  // autre, sinon il tourne, il dépense, et rien ne bouge à l'écran.
  window.zyvro.agent.onWoke(({ conversationId, turnId, prompt }) => {
    if (!state.threads.some((thread) => thread.id === conversationId)) return
    bindTurn(conversationId, beginTurn(conversationId, prompt), turnId)
  })

  window.zyvro.agent.onToolResult(({ id, callId, output, isError, images }) => {
    const bound = turnToMessage.get(id)
    // Le résultat retrouve son appel par son identifiant, jamais par l'ordre
    // d'arrivée : deux commandes lancées ensemble reviennent dans l'ordre où
    // elles finissent. La place du morceau, elle, ne bouge pas.
    const settle = (parts: Part[]): Part[] =>
      parts.map((part) =>
        part.kind === "tool" && part.call.callId === callId
          ? { kind: "tool", call: { ...part.call, output, images, isError, finished: true } }
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

// dispatch : envoyer un message pour une conversation, sans passer par l'écran.
//
// Sorti du composant parce que la file doit repartir **même dans un onglet
// qu'on ne regarde pas**. C'est tout l'intérêt des onglets : un tour lancé ici
// continue pendant qu'on lit ailleurs. Une file qui n'avancerait que dans la
// conversation affichée serait une file qui s'arrête dès qu'on change de
// fenêtre — exactement au moment où on comptait sur elle.
//
// Tout ce dont un envoi a besoin vit déjà au niveau du module : l'état des
// conversations, le client de requêtes, le projet, la permission. Il ne restait
// dans le composant que ce qui touche à la zone de saisie.
async function dispatch(threadId: string, text: string, images: Attached[]): Promise<void> {
  const thread = threadById(threadId)
  const projectDir = useWorkspace.getState().project?.project ?? null
  if (!thread || projectDir === null) return

  const messageId = beginTurn(threadId, text, images)

  // La liste des workflows est du contexte, pas une condition : si le démon
  // local ne répond pas, l'agent tourne quand même — il ne connaîtra
  // simplement pas les workflows par leur nom.
  let workflows: WorkflowRef[] = []
  try {
    const listed = await queryClient.fetchQuery({ queryKey: WORKFLOWS_KEY, queryFn: () => api.listWorkflows() })
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
      thread.kind,
      text,
      workflows,
      threadId,
      thread.model,
      images.map((i) => i.id),
      permissionFor(projectDir)
    )
    bindTurn(threadId, messageId, turnId)
  } catch (error: unknown) {
    failTurn(threadId, messageId, error instanceof Error ? error.message : String(error))
  }
}

// advance : le tour est fini, au suivant s'il y en a un.
//
// Trois règles, et chacune existe parce que l'inverse surprendrait :
//
// · **Un tour arrêté à la main vide la file.** « Stop » veut dire stop. Faire
//   partir le message suivant une demi-seconde après avoir cliqué serait le
//   contraire de ce qu'on vient de demander — et ça dépense.
// · **Un tour en erreur n'enchaîne pas.** Une erreur est une raison de
//   regarder, pas de continuer : enchaîner ferait défiler trois échecs
//   identiques pendant qu'on lit le premier. Les messages restent visibles et
//   repartent d'un clic.
// · **Sinon, le premier de la file part tout seul**, avec les images qui
//   avaient été choisies avec lui.
function advance(threadId: string, ok: boolean): void {
  const thread = threadById(threadId)
  if (!thread || thread.queued.length === 0) return
  if (!ok) return
  const [suivant, ...reste] = thread.queued
  mapThread(threadId, (t) => ({ ...t, queued: reste }))
  // Une micro-tâche : `advance` est appelée depuis la mise à jour d'état qui
  // termine le tour, et repartir dedans ferait un envoi pendant un rendu.
  window.queueMicrotask(() => void dispatch(threadId, suivant.text, suivant.images))
}

function endTurn(id: string): void {
  const bound = turnToMessage.get(id)
  turnToMessage.delete(id)
  orphans.delete(id)
  cancelled.delete(id)
  if (!bound) return
  const arrete = cancelled.has(id)
  mapThread(bound.threadId, (thread) =>
    thread.turnId === id || thread.busy ? { ...thread, turnId: null, busy: false } : thread
  )
  persist(bound.threadId)
  // Le tour est terminé : c'est maintenant que la file avance, si elle le doit.
  const fini = threadById(bound.threadId)?.messages.find((m) => m.id === bound.messageId)
  advance(bound.threadId, !arrete && !fini?.error)
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
function beginTurn(threadId: string, prompt: string, images: Attached[] = []): string {
  const assistantId = nextMessageId()
  const user: ChatMessage = {
    id: nextMessageId(),
    role: "user",
    // L'image envoyée reste visible dans la conversation.
    //
    // Avant, il n'en restait qu'un nom précédé d'un trombone : les puces
    // disparaissaient avec l'envoi et le transcript ne montrait plus rien. « On
    // ne la voit pas dans le chat » — non, et c'était le seul endroit où elle
    // aurait eu du sens, puisque c'est là qu'on relit ce qu'on a demandé.
    //
    // Le message garde donc les identifiants, pas les octets : le fichier vit à
    // côté de la conversation et s'en va avec elle, et la vignette se redemande
    // au processus principal quand on l'affiche.
    parts: [{ kind: "text", text: prompt }],
    images,
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
    title: thread.messages.length === 0 ? titleFrom(prompt || images[0]?.name || "") : thread.title,
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
    // Une image sans un mot est un message : « regarde ça » se dit très bien
    // en déposant une capture, et le filtre d'avant la jetait à l'écriture.
    .filter((m) => textOf(m) !== "" || toolsOf(m).length > 0 || (m.images?.length ?? 0) > 0 || m.error)
    .map((m) => ({
      role: m.role,
      spent: m.spent,
      images: m.images,
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
                images: part.call.images,
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
    goal: thread.goal,
    // Main overwrites this with what the CLI actually reported; sending what we
    // last knew keeps a conversation whose session has not changed intact.
    sessionId: null,
    model: thread.model,
    // Ce que chaque harnais avait épinglé : basculer et revenir retrouve le
    // sien plutôt que d'hériter de celui du voisin, qui répondrait « that model
    // may not exist » pour un nom qu'il n'a jamais proposé.
    models: { ...thread.models, [thread.kind]: thread.model },
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
  // Rien à relire n'est pas rien à faire : un tour peut tourner dans une
  // conversation qui n'a encore jamais été écrite sur le disque — le premier,
  // justement, celui qu'on lance avant de sauver un fichier.
  if (usable.length === 0) {
    await reattach()
    return
  }

  const threads: Thread[] = usable.map((c) => ({
    id: c.id,
    title: c.title || "New chat",
    messages: c.messages.map((m) => ({
      id: nextMessageId(),
      role: m.role,
      parts: restoreParts(m),
      spent: m.spent,
      images: m.images,
      error: m.error,
      streaming: false,
    })),
    turnId: null,
    busy: false,
    model: c.model ?? null,
    // Un fichier écrit avant que les modèles soient séparés n'en porte qu'un :
    // il appartient au harnais que la conversation portait alors.
    models: c.models ?? (c.model ? { [c.kind]: c.model } : {}),
    // Le but tel qu'il était à la fermeture.
    //
    // Ce commentaire affirmait qu'il « survit dans la session du harnais,
    // vérifié sur claude ». C'est faux, mesuré le 18/09 : en mode impression,
    // un but posé dans un tour a disparu au suivant — chaque tour est un
    // processus, et la commande locale ne laisse rien derrière elle. Ce qu'on
    // réaffiche est donc le dernier état connu, pas un état relu du harnais.
    goal: c.goal ?? null,
    // Les réveils vivent en mémoire : une boucle tient tant que la fenêtre
    // tient. Une conversation rouverte n'en a donc pas, et c'est la vérité
    // plutôt qu'un décompte qui ne réveillerait personne.
    pending: null,
    ranWith: c.ranWith ?? null,
    kind: c.kind,
    images: [],
    // Une file en attente ne survit pas à la fermeture, et c'est voulu : ces
    // messages n'ont jamais été envoyés. Les retrouver au prochain démarrage
    // les ferait partir tout seuls, longtemps après, sur un projet peut-être
    // rouvert pour autre chose — et chacun coûte un tour.
    queued: [],
    // L'empreinte de ce qui est sur le disque, dans la forme où on l'écrirait :
    // sans ça, le premier tour réécrirait un transcript identique.
    saved: "",
  }))
  commit({ threads, activeId: threads[0].id, asks: state.asks })
  await reattach()
}

// reattach : se raccrocher aux tours qui tournent encore.
//
// Signalé par Jeremy : « quand tu modifies un fichier, ça recharge le front, ça
// ne reprend pas les sessions d'agent sur les apps qui tournent ». En
// développement, `electron-vite` recharge le rendu à chaque fichier sauvé — ce
// qui rend l'outil agréable à écrire — mais le processus principal ne redémarre
// pas. Le tour continuait donc, il dépensait, et la page neuve n'avait plus
// aucune idée de son existence : ses événements arrivaient avec un identifiant
// que personne ne connaissait plus, et le panneau les garait comme
// « orphelins » pour toujours. L'écran ne bougeait plus d'une ligne.
//
// Ce n'est pas qu'un confort de développement : la même chose arrive à
// quiconque recharge la fenêtre pendant qu'un agent travaille.
//
// La question elle-même est reprise du processus principal, pas du disque : un
// tour en vol n'y est pas encore écrit — le transcript n'est enregistré qu'à la
// fin — donc le principal est le seul à l'avoir.
async function reattach(): Promise<void> {
  const running = await window.zyvro.agent.running().catch(() => [])
  for (const { id, conversationId, prompt } of running) {
    // Une conversation neuve n'est pas encore sur le disque : son premier tour
    // est en vol, et `restore` n'a donc rien trouvé à recréer. On lui refait un
    // onglet, sous son identifiant à elle — celui que le processus principal et
    // la session de la CLI connaissent déjà.
    if (!threadById(conversationId)) {
      // S'il y a un onglet vide — celui que le panneau ouvre toujours au
      // démarrage — on lui donne cet identifiant plutôt que d'en ajouter un à
      // côté : sinon la reprise laisse un « New chat » orphelin derrière elle.
      const vide = state.threads.find((t) => t.messages.length === 0 && !t.busy)
      const threads = vide
        ? state.threads.map((t) => (t.id === vide.id ? { ...t, id: conversationId } : t))
        : [{ ...blankThread(), id: conversationId }, ...state.threads]
      commit({ ...state, threads, activeId: conversationId })
    }
    const messageId = beginTurn(conversationId, prompt, [])
    bindTurn(conversationId, messageId, id)
    // Lié d'abord, rejoué ensuite : les événements portent l'identifiant du
    // tour, et une page qui ne l'a pas encore lié les garerait une seconde fois.
    await window.zyvro.agent.replay(id).catch(() => false)
  }
}

// GoalBanner : ce vers quoi la session travaille.
//
// Ce qu'il montre est ce que le harnais donne, et rien de plus : l'objectif
// toujours, le statut et l'avancement quand il les compte. qwen compte les
// tours et les jetons sur un budget ; claude dit « not yet evaluated ».
// Inventer une barre de progression là où il n'y a pas de chiffre serait
// dessiner une certitude que personne n'a.
function GoalBanner({ goal }: { goal: Goal }): JSX.Element {
  const atteint = /achiev|done|complete|réussi/i.test(goal.status)
  return (
    <div
      className={cn(
        "flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-[11px] leading-snug",
        atteint
          ? "border-emerald-400/20 bg-emerald-400/[0.06]"
          : "border-white/[0.06] bg-primary/[0.05]"
      )}
    >
      <Target className={cn("mt-px h-3 w-3 shrink-0", atteint ? "text-emerald-300" : "text-primary")} />
      <div className="min-w-0 flex-1">
        <div className="break-words text-foreground">{goal.objective}</div>
        {(goal.status || goal.turns !== undefined || goal.tokens) && (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {[
              goal.status,
              goal.turns !== undefined ? `${goal.turns} turn${goal.turns === 1 ? "" : "s"}` : null,
              goal.tokens ? `${compact(goal.tokens.used)} / ${compact(goal.tokens.budget)} tokens` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
    </div>
  )
}

// ScheduleBanner : la session a rendez-vous avec elle-même.
//
// Ce qu'il doit dire tient en trois choses : dans combien de temps, pour faire
// quoi, et comment arrêter. La troisième est la plus importante — une boucle
// qu'on ne peut pas arrêter depuis l'endroit où on la voit n'est pas une
// fonctionnalité, c'est une fuite.
//
// Le décompte se recalcule à chaque seconde depuis une date absolue, et pas en
// retranchant un : une fenêtre restée en arrière-plan reçoit ses minuteries en
// retard, et un compteur qui décrémente dériverait de tout ce temps-là.
function ScheduleBanner({ pending, onStop }: { pending: Pending; onStop: () => void }): JSX.Element {
  const maintenant = useSyncExternalStore(everySecond, () => Math.floor(Date.now() / 1000), () => 0)
  const reste = Math.max(0, pending.at - maintenant * 1000)
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.06] px-3 py-1.5 text-[11px] leading-snug">
      <Repeat className="h-3 w-3 shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <span className="text-foreground">
          {reste === 0 ? "Running now" : `Next run in ${duree(reste)}`}
          {pending.cron ? ` · ${pending.cron}` : ""}
        </span>
        <div className="truncate font-mono text-[10px] text-muted-foreground" title={pending.prompt}>
          {pending.prompt}
        </div>
      </div>
      <button
        type="button"
        onClick={onStop}
        title="Stop this loop"
        className="shrink-0 rounded border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-[11px] text-foreground hover:bg-white/[0.08]"
      >
        Stop
      </button>
    </div>
  )
}

// duree : « 4 min », « 1 h 20 min », « 12 s ». Pas de secondes au-delà d'une
// minute — elles défilent sans rien apprendre — et pas de « 0 h » non plus.
function duree(ms: number): string {
  const secondes = Math.round(ms / 1000)
  if (secondes < 60) return `${secondes} s`
  const minutes = Math.round(secondes / 60)
  if (minutes < 60) return `${minutes} min`
  const heures = Math.floor(minutes / 60)
  const reste = minutes % 60
  return reste === 0 ? `${heures} h` : `${heures} h ${reste} min`
}

// everySecond : un abonnement que tout le panneau partage, plutôt qu'une
// minuterie par bannière. Il n'y en a qu'une à l'écran, mais c'est la forme qui
// évite d'écrire un effet — ce dépôt n'en écrit pas.
const tics = new Set<() => void>()
let horloge: ReturnType<typeof setInterval> | null = null
function everySecond(listener: () => void): () => void {
  tics.add(listener)
  if (horloge === null) horloge = setInterval(() => tics.forEach((t) => t()), 1000)
  return () => {
    tics.delete(listener)
    if (tics.size === 0 && horloge !== null) {
      clearInterval(horloge)
      horloge = null
    }
  }
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
    return {
      callId: stored,
      running: stored,
      done: stored,
      shape: "other",
      detail: "",
      plan: [],
      output: "",
      images: [],
      isError: false,
      finished: true,
    }
  }
  return {
    callId: stored.callId,
    running: stored.done,
    done: stored.done,
    shape: (stored.shape as ToolCall["shape"]) ?? "other",
    detail: stored.detail ?? "",
    plan: stored.plan ?? [],
    images: stored.images ?? [],
    output: stored.output ?? "",
    isError: Boolean(stored.isError),
    finished: true,
  }
}

function setModel(threadId: string, model: string | null): void {
  mapThread(threadId, (thread) => ({
    ...thread,
    model,
    models: { ...thread.models, [thread.kind]: model },
  }))
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
  mapThread(threadId, (thread) => {
    // Une session garde son harnais. C'est lui qui tient le fil côté CLI — la
    // session qu'on reprend d'un tour à l'autre lui appartient — et en changer
    // au milieu, c'est demander à quelqu'un d'autre de finir une phrase qu'il
    // n'a pas entendue. L'écran ne le propose plus une fois commencé ; ceci
    // est la règle, à l'endroit où elle ne dépend pas de l'écran.
    if (thread.messages.length > 0) return thread
    // Ce que ce harnais avait épinglé la dernière fois, et rien s'il n'a jamais
    // rien épinglé : le défaut appartient à la CLI et se lit sur son premier
    // tour. Garder le modèle du harnais précédent, c'est lui demander un nom
    // qu'il ne connaît pas.
    const models = { ...thread.models, [thread.kind]: thread.model }
    return { ...thread, kind, models, model: models[kind] ?? null, ranWith: null }
  })
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
  // Une session « commencée » est une session qui a un fil côté CLI. C'est le
  // premier message envoyé qui le crée, pas le premier caractère tapé : tant
  // que rien n'est parti, tout se change encore.
  const started = thread.messages.length > 0
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
  // Où est le curseur : une commande ne se complète que tant qu'on est dedans,
  // pas quand on est revenu écrire au milieu d'une phrase qui commence par une
  // barre oblique.
  const [caret, setCaret] = useState(0)

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
    if ((text === "" && thread.images.length === 0) || project === null) return
    const threadId = thread.id
    const images = thread.images

    // La boîte se vide dans les deux cas : ce qu'on vient d'écrire est parti
    // quelque part, en vol ou en file, et le laisser à l'écran ferait croire
    // qu'il n'est pas parti.
    setDraft("")
    const node = composer.current
    if (node) node.style.height = ""
    // The chips clear with the message they went with: they belong to what was
    // just sent, not to whatever gets typed next.
    mapThread(threadId, (t) => ({ ...t, images: [] }))

    // Pendant qu'un tour tourne, on met en file au lieu de refuser.
    //
    // Avant, la touche Entrée ne faisait rien : le texte restait dans la boîte
    // et on l'y retrouvait, ou pas, selon qu'on avait regardé. Or c'est le
    // moment où l'on a le plus d'idées — l'agent travaille, on lit sa réponse,
    // on pense à la suite. Elle part maintenant toute seule au tour suivant.
    if (thread.busy) {
      mapThread(threadId, (t) => ({
        ...t,
        queued: [...t.queued, { id: nextMessageId(), text, images }],
      }))
      return
    }

    await dispatch(threadId, text, images)
  }

  const stop = (): void => {
    const turnId = thread.turnId
    if (turnId === null) return
    markCancelled(turnId)
    void window.zyvro.agent.cancel(turnId)

    // « Stop » vide la file, et rend ce qu'elle contenait.
    //
    // La vider est la seule lecture honnête du bouton : laisser des messages
    // prêts à partir au prochain tour ferait repartir, plus tard, ce qu'on
    // venait d'interrompre. Mais les jeter serait perdre ce que quelqu'un a
    // écrit, alors ils reviennent dans la boîte — elle est vide à ce
    // moment-là, puisqu'écrire les y avait retirés.
    const attente = thread.queued
    if (attente.length === 0) return
    mapThread(thread.id, (t) => ({ ...t, queued: [], images: [...t.images, ...attente.flatMap((q) => q.images)] }))
    setDraft((actuel) => [actuel, ...attente.map((q) => q.text)].filter(Boolean).join("\n\n"))
  }

  // ---- le menu de la barre oblique ----------------------------------------
  //
  // Les harnais ont leurs propres commandes — 107 pour claude sur cette machine
  // avec ses greffons, 27 pour qwen — et elles marchent déjà : ce qu'on tape
  // part sur l'entrée standard, et la CLI les exécute. Vérifié plutôt que
  // supposé : `claude -p "/context"` rend le vrai rapport de contexte, pas le
  // modèle qui parle du mot.
  //
  // Ce qui manquait n'était donc pas l'exécution, c'était de savoir qu'elles
  // existent. Le menu lit la liste que le harnais annonce, jamais une liste
  // écrite ici — celle-là serait fausse chez la première personne qui installe
  // un greffon.
  const toutes = commandsFor(kind)
  useSyncExternalStore(subscribeCommands, () => commandsKey(kind), () => "")
  const tape = slashPrefix(draft, caret)
  const proposees = tape === null ? [] : matching(toutes, tape)
  const menuOuvert = proposees.length > 0
  // Ce qu'on a tapé est déjà un nom de commande entier : il n'y a plus rien à
  // compléter, seulement à envoyer.
  const dejaComplet = tape !== null && proposees.some((nom) => nom.toLowerCase() === tape.toLowerCase())
  const [choisi, setChoisi] = useState(0)
  const surligne = Math.min(choisi, Math.max(0, proposees.length - 1))

  const completer = (nom: string): void => {
    // Un espace derrière : la plupart de ces commandes prennent un argument, et
    // celles qui n'en prennent pas s'accommodent d'un espace en trop.
    setDraft(`/${nom} `)
    setChoisi(0)
    const node = composer.current
    if (node) {
      node.focus()
      grow(node)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOuvert) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setChoisi((v) => (v + 1) % proposees.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setChoisi((v) => (v - 1 + proposees.length) % proposees.length)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        // Fermer sans effacer : on ferme le menu, pas ce qu'on écrivait.
        setDraft(`${draft} `)
        return
      }
      if (event.key === "Tab") {
        event.preventDefault()
        completer(proposees[surligne])
        return
      }
      if (event.key === "Enter" && !event.shiftKey && !dejaComplet) {
        // Entrée complète au lieu d'envoyer : expédier `/lo` à la CLI, c'est
        // une commande inconnue et un tour perdu.
        //
        // Mais seulement tant qu'il reste quelque chose à compléter. `/goal`
        // est un nom entier autant qu'un préfixe de lui-même : « compléter »
        // n'y changerait rien et mangerait la touche, et la commande ne
        // partirait jamais. Vu en l'essayant.
        event.preventDefault()
        completer(proposees[surligne])
        return
      }
    }
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
  // Ce que l'arbre nous remet par le menu contextuel. Même écriture que pour un
  // dépôt — c'est le même geste dit autrement, et deux façons de citer un
  // chemin, c'est une des deux qui se trompe le jour où un dossier a un espace.
  const remis = useSyncExternalStore(subscribeHandoff("agent"), () => tokenOf("agent"), () => 0)
  const attendait = useRef(0)
  if (remis !== attendait.current) {
    attendait.current = remis
    const texte = takeHandoff("agent")
    // Pris, pas lu : un deuxième rendu ne doit pas le réécrire.
    if (texte) window.queueMicrotask(() => insertPaths([texte]))
  }

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

  // La bonne question n'est pas « un projet est-il ouvert » mais « y a-t-il un
  // moteur à qui parler ». Les deux se confondaient parce qu'un moteur naissait
  // avec un projet ; ce n'est plus vrai, et demander l'ancienne refusait le
  // travail global — « les agents sont utilisables même si aucun projet n'est
  // ouvert, ce sont des agents globaux ». Sans projet, l'agent tourne dans le
  // dossier d'accueil.
  const pret = useSyncExternalStore(subscribeEngine, engineReady, () => false)
  const disabled = !pret

  // Lâcher un fichier : tout le panneau l'attrape, pas seulement le champ.
  //
  // Le champ fait deux centimètres de haut au fond d'une colonne, et viser deux
  // centimètres avec un fichier au bout du curseur est un geste qu'on rate.
  // Toute la colonne est donc la cible — et elle seule : le terminal a son
  // propre dépôt, qui écrit le chemin dans le shell, et le lui prendre serait
  // échanger une gêne contre une surprise.
  //
  // `dragleave` compte les entrées et les sorties plutôt que de croire le
  // premier venu : sur un conteneur qui a des enfants, il part à chaque fois
  // que le curseur passe de l'un à l'autre, et le cadre clignoterait tout du
  // long.
  const survol = useRef(0)
  const onDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!carriesPaths(event)) return
    event.preventDefault()
    setDropping(true)
  }
  const onDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!carriesPaths(event)) return
    survol.current += 1
    setDropping(true)
  }
  const onDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!carriesPaths(event)) return
    survol.current = Math.max(0, survol.current - 1)
    if (survol.current === 0) setDropping(false)
  }
  const onDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!carriesPaths(event)) return
    event.preventDefault()
    survol.current = 0
    setDropping(false)
    // Un fichier venu du Finder peut être une image à joindre ; un fichier venu
    // de l'arbre est toujours une désignation, et il n'y a rien à lire à son
    // sujet — le projet est déjà ouvert.
    const files = [...event.dataTransfer.files]
    if (files.length > 0) {
      void take(files)
      return
    }
    insertPaths(droppedPaths(event))
  }

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col bg-background",
        dropping && "ring-2 ring-inset ring-primary/60"
      )}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Ce qu'on s'apprête à lâcher, dit en grand plutôt que par un liseré :
          on arrive avec un fichier au bout du curseur et on veut savoir que
          c'est ici que ça tombe. Sans `pointer-events`, sinon le voile
          intercepte le dépôt qu'il annonce. */}
      {dropping && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-primary/[0.07]">
          <span className="rounded-md border border-primary/40 bg-background/90 px-3 py-1.5 text-xs text-foreground">
            Drop to attach an image, or write its path
          </span>
        </div>
      )}
      {/* Rien ne doit sortir de cette barre. Le panneau se redimensionne, et le
          nom du modèle est choisi par la CLI — « claude-opus-5[1m] (default) »
          est plus long que « claude-haiku-4-5 ». Sans de quoi rétrécir, c'est
          le bouton de droite qui passait dehors : le seul qui ouvre une
          nouvelle session, et il disparaissait sans bruit. C'est aussi
          pourquoi le choix du harnais a quitté cette barre pour le corps de la
          session : trois boutons de plus ici, et elle débordait encore. */}
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-white/[0.06] px-2">
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">Agent</span>

        {/* Une fois la session commencée, l'en-tête ne propose plus de choix :
            il rappelle ce qu'elle est. Le harnais est figé — c'est lui qui
            tient le fil de la conversation côté CLI, et en changer au milieu
            reviendrait à demander à quelqu'un d'autre de continuer une phrase
            qu'il n'a pas entendue. Le modèle, lui, se change encore : c'est un
            choix à l'intérieur du même harnais. */}
        {started ? (
          <>
            <span
              className="ml-auto shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              title={`This session runs ${kind}. A session keeps its harness: it is the one holding the thread.`}
            >
              {kind}
            </span>
            <div className="min-w-0 max-w-[9rem]">
              <ModelPicker
                kind={kind}
                model={thread.model}
                ranWith={thread.ranWith}
                onChange={(model) => setModel(thread.id, model)}
              />
            </div>
          </>
        ) : (
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">New session</span>
        )}

        <button
          type="button"
          onClick={openThread}
          title="New session"
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

      {/* Le but, épinglé.
          Au-dessus du défilement et pas dedans : une session qui travaille vers
          quelque chose doit le dire en permanence, et un but tapé au troisième
          message a disparu de l'écran au dixième. C'est la différence entre un
          chat et un atelier. */}
      {thread.goal && <GoalBanner goal={thread.goal} />}

      {/* Le rendez-vous, s'il y en a un. Sous le but, parce que le but dit vers
          quoi on va et celui-ci seulement quand on y retourne. */}
      {thread.pending && (
        <ScheduleBanner
          pending={thread.pending}
          onStop={() => {
            mapThread(thread.id, (t) => ({ ...t, pending: null }))
            void window.zyvro.agent.unschedule(thread.id)
          }}
        />
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!started ? (
          <div className="space-y-3 text-xs text-muted-foreground">
            {/* Le choix se fait ici, avant le premier message, et pas dans la
                barre du haut : c'est le moment où il se décide, et un réglage
                montré au moment où il compte n'a pas besoin d'être cherché.
                Après, il disparaît — le harnais est figé et le rappeler comme
                un bouton inviterait à cliquer dessus pour rien. */}
            <div className="space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.03] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide">Harness</span>
                <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.04] p-0.5">
                  {AGENT_KINDS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setKind(thread.id, option)}
                      title={`Run this session with ${option}`}
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                        kind === option
                          ? "bg-white/[0.08] text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide">Model</span>
                <div className="min-w-0 max-w-[13rem]">
                  <ModelPicker
                    kind={kind}
                    model={thread.model}
                    ranWith={thread.ranWith}
                    onChange={(model) => setModel(thread.id, model)}
                  />
                </div>
              </div>
              <p className="leading-snug text-[11px] text-muted-foreground/80">
                The harness is fixed once this session starts — it is the one holding the thread. Open a
                new session to use another.
              </p>
            </div>
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
              <Bubble
                key={message.id}
                message={message}
                kind={kind}
                showSpent={showSpent}
                conversationId={thread.id}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.06] p-2">
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
                <Thumb conversationId={thread.id} image={image} size="h-6 w-6" />
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

        {/* Les commandes du harnais, quand on commence par une barre oblique.
            Au-dessus de la saisie et pas en dessous : la saisie est déjà en bas
            de la fenêtre, et un menu sous elle sortirait de l'écran. */}
        {menuOuvert && (
          <div className="zy-scroll mb-1.5 max-h-48 overflow-y-auto rounded-md border border-white/[0.08] bg-background/95 p-1">
            {proposees.slice(0, 40).map((nom, index) => (
              <button
                key={nom}
                type="button"
                onMouseEnter={() => setChoisi(index)}
                onClick={() => completer(nom)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11px]",
                  index === surligne ? "bg-white/[0.09] text-foreground" : "text-muted-foreground"
                )}
              >
                /{nom}
              </button>
            ))}
            {proposees.length > 40 && (
              <div className="px-2 py-1 text-[10px] text-muted-foreground/70">
                et {proposees.length - 40} autres — précisez
              </div>
            )}
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

        {/* Ce qui partira tout seul au prochain tour.
            Visible, et retirable un par un. Une file qu'on ne voit pas est une
            file qui dépense sans qu'on l'ait voulu — c'est la leçon de la
            boucle invisible : « le décompte repartait, de vrais tours
            tournaient, et l'écran ne bougeait pas d'une ligne ». */}
        {thread.queued.length > 0 && (
          <div className="mb-1.5 space-y-1">
            {thread.queued.map((q, index) => (
              <div
                key={q.id}
                className="flex items-start gap-2 rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] text-muted-foreground"
              >
                <span className="mt-[1px] shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate" title={q.text}>
                  {q.text || `${q.images.length} image${q.images.length === 1 ? "" : "s"}`}
                </span>
                {q.images.length > 0 && q.text !== "" && (
                  <Paperclip className="mt-[1px] h-3 w-3 shrink-0 text-muted-foreground/70" />
                )}
                <button
                  type="button"
                  title="Remove from the queue"
                  className="shrink-0 rounded p-0.5 hover:bg-white/[0.1] hover:text-foreground"
                  onClick={() =>
                    mapThread(thread.id, (t) => ({ ...t, queued: t.queued.filter((x) => x.id !== q.id) }))
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <p className="px-0.5 text-[10px] text-muted-foreground/70">
              {thread.queued.length === 1 ? "Sent on its own" : "Sent one at a time"} when this turn ends. Stop puts
              {thread.queued.length === 1 ? " it" : " them"} back in the box.
            </p>
          </div>
        )}

        {/* Deux rangées : ce qu'on écrit, puis ce qui le gouverne.
            Sur une seule, le sélecteur de droits et le trombone mangeaient la
            moitié d'un panneau large de 360 points — il restait une ligne de
            texte étroite, et les trois hauteurs ne tombaient jamais juste. */}
        <div
          className={cn(
            "rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-2 focus-within:border-white/[0.12]"
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
              setCaret(event.target.selectionStart ?? event.target.value.length)
              setChoisi(0)
              grow(event.currentTarget)
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
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
  conversationId,
}: {
  message: ChatMessage
  kind: AgentKind
  showSpent: boolean
  /** La conversation à laquelle demander les vignettes : un fichier joint
   *  appartient à une conversation, pas à l'application. */
  conversationId: string
}): JSX.Element {
  if (message.role === "user") {
    const images = message.images ?? []
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs leading-relaxed text-foreground">
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">You</div>
        {textOf(message) ? (
          <div className="whitespace-pre-wrap break-words">{textOf(message)}</div>
        ) : null}
        {/* Ce qu'on a envoyé, montré. Plus grand que dans la puce parce qu'ici
            on relit ce qu'on a demandé, et qu'une capture de seize pixels de
            côté ne se relit pas. */}
        {images.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", textOf(message) ? "mt-1.5" : "")}>
            {images.map((image) => (
              <Thumb key={image.id} conversationId={conversationId} image={image} size="h-20 w-20" />
            ))}
          </div>
        )}
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
            <ToolRow call={part.call} conversationId={conversationId} />
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
