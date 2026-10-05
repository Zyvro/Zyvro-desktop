import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
// L'instance de module : `dispatch` envoie hors de tout composant, donc il ne
// peut pas demander la sienne à un crochet. C'est la même, celle que la
// doctrine impose de tenir ici plutôt que d'en fabriquer une par rendu.
import { queryClient } from "~/lib/queryClient"
import {
  ArrowUp,
  Download,
  Image as ImageIcon,
  MessageSquarePlus,
  Paperclip,
  Repeat,
  Square,
  SquareTerminal,
  Target,
  TerminalSquare,
  X,
  Volume2,
  VolumeX,
} from "lucide-react"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { AgentKind, Spent, WorkflowRef } from "../../preload"
import { harness } from "../../shared/harness"
import { droppedText, insertAt } from "../../shared/dropped"
import { compact, detail, subscribeUsage, usageShown } from "~/lib/usage"
import { clockTime, formatDuration } from "~/lib/duration"
import { carriesPaths, droppedPaths } from "~/state/dropped"
import { permission as agentPermission, setPermission, subscribePermission } from "~/state/permission"
import { askHarness } from "~/state/persistent"
import { askConfirm } from "~/state/prompt"
import {
  blankKey,
  cancelHistory,
  chipsFor,
  draftFor,
  draftShown,
  forgetDraft,
  holdsBlank,
  inHistory,
  keepChips,
  keepQueued,
  leaveHistory,
  releaseBlank,
  rememberPrompt,
  restoreQueued,
  setDraftFor,
  stepHistory,
  subscribeDrafts,
} from "~/state/composer"
import { installHarness, NODE_DOWNLOAD_URL, useHarnessesInstalled } from "~/lib/harnessInstall"
import { HARNESS_TINT, renderCode, Working } from "~/lib/chatColors"
import { speakingId, speechAvailable, subscribeSpeech, toggleSpeech } from "~/lib/speech"
import { HarnessPicker } from "~/panels/HarnessPicker"
import { useWorkspace } from "../state/workspace"
import { ModelPicker } from "~/panels/ModelPicker"
import { SkillsButton } from "~/panels/SkillsButton"
import { getSettings, subscribeSettings } from "~/state/settings"
import { ContextCompact } from "~/panels/ContextCompact"
import { PermissionPicker } from "~/panels/PermissionPicker"
import { SynthesisPicker } from "~/panels/SynthesisPicker"
import { commandsFor, commandsKey, matching, noteCommands, slashPrefix, subscribeCommands } from "~/state/commands"
import { synthesisSettings } from "~/state/synthesis"
import { ToolRow, type ToolCall } from "~/panels/ToolRow"
import { BugButton } from "~/panels/BugReportDialog"
import { PromptProject } from "~/panels/ProjectIcon"
import { reportIncident } from "~/state/bugReport"
import { QuestionCard } from "~/panels/QuestionCard"
import type { AgentQuestion, QuestionAnswers } from "../../shared/questions"
import type { Goal, Pending } from "../../preload"
import { Thumb, type Attached } from "~/panels/Thumb"
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
  // Quand la réponse a commencé et fini, en ms depuis l'époque : la durée qui
  // défile à côté de « Writing », puis « Cogitated for 3s · done 23:55 ».
  startedAt?: number
  endedAt?: number
}

// ended : la réponse s'arrête — fin, erreur, Stop, message glissé. La première
// fin compte : un `done` qui suit une erreur ne la repousse pas.
function ended(message: ChatMessage): ChatMessage {
  return { ...message, streaming: false, endedAt: message.endedAt ?? Date.now() }
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
  advancedSkills: boolean
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
  /**
   * Jetons dans le contexte, tels que le dernier reçu les a mesurés.
   *
   * Null tant qu'aucun tour n'a parlé — ou depuis un `/compact`, tant que le
   * suivant n'a pas rendu la taille réelle. On ne la devine pas : un
   * pourcentage faux est pire qu'un pourcentage absent.
   */
  context: number | null
}

/** Un message en attente. Il porte ses images : elles ont été choisies avec lui. */
type Queued = {
  id: string
  text: string
  images: { id: string; name: string }[]
  /** Envoyé dans le tour en cours (Claude, Codex), pas encore pris par l'agent. */
  steering?: boolean
}

/**
 * Ce message peut-il être glissé dans le tour en cours, plutôt qu'attendre sa
 * fin ? Claude et Codex savent le lire en plein tour ; les autres attendent.
 * Pas avec des images (elles passent par la question du tour), pas une
 * commande `/` (elle est faite pour ouvrir un tour), et pas devant un message
 * qui attendait déjà — l'ordre de la file reste celui de l'envoi.
 */
export function canSteer(
  thread: { kind: AgentKind; turnId: string | null; queued: Queued[] },
  text: string,
  images: unknown[]
): boolean {
  if (thread.turnId === null) return false
  if (thread.kind !== "claude" && thread.kind !== "codex") return false
  if (images.length > 0 || text.trim() === "" || text.trimStart().startsWith("/")) return false
  return thread.queued.every((q) => q.steering === true)
}

// Une demande de permission en attente : ce que la CLI veut faire, et les deux
// boutons qui décident. Elle vit au niveau du panneau et non d'une conversation
// parce que c'est la CLI qui la pose, au milieu d'un tour, sans dire lequel.
//
// `questions` présent : ce n'est pas une permission mais les questions de
// l'agent, et la carte est un formulaire (QuestionCard).
type Ask = { id: string; tool: string; input: Record<string, unknown>; questions?: AgentQuestion[] }

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

function blankThread(model: string | null = getSettings().agent.defaultModels[getSettings().agent.defaultKind] ?? null, kind: AgentKind = getSettings().agent.defaultKind): Thread {
  return {
    advancedSkills: false,
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
    context: null,
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
// Les tours qui viennent de compacter : leur usage rapporte l'ANCIEN contexte
// (la summarization relit tout), et le remettre à jour rafficherait 100% juste
// après avoir vidé. Le vrai nouveau contexte arrive au tour suivant.
const compacting = new Set<string>()

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

function mapThread(id: string, applied: (thread: Thread) => Thread): void {
  // Toute file d'attente passe par ici : son texte est gardé hors de la
  // mémoire, pour qu'un redémarrage le rende au lieu de le jeter (restore).
  const change = (thread: Thread): Thread => {
    const next = applied(thread)
    if (next.queued !== thread.queued) keepQueued(id, next.queued.map((q) => q.text))
    // Les images aussi : celles de la boîte et celles parties en file, qui
    // reviennent ensemble dans la boîte au redémarrage, comme avec « Stop ».
    if (next.images !== thread.images || next.queued !== thread.queued) {
      keepChips(id, [...next.images, ...next.queued.flatMap((q) => q.images)])
    }
    return next
  }
  let touched = false
  const threads = state.threads.map((thread) => {
    if (thread.id !== id) return thread
    touched = true
    return change(thread)
  })
  if (!touched) {
    // Le fil n'est pas à l'écran : il appartient peut-être à un projet en
    // arrière-plan, dont l'état est rangé. Un tour en vol continue de parler
    // même quand on a basculé — il faut que son fil reçoive, sinon on perd le
    // streaming et le transcript.
    for (const [project, snapshot] of chatByProject) {
      const found = snapshot.threads.find((t) => t.id === id)
      if (!found) continue
      chatByProject.set(project, {
        ...snapshot,
        threads: snapshot.threads.map((t) => (t.id === id ? change(t) : t)),
      })
      return
    }
    return
  }
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
  // Réglée sans nous — tour interrompu, délai passé : la carte s'en va.
  window.zyvro.agent.onPermissionGone(({ id }) => {
    if (state.asks.some((ask) => ask.id === id)) commit({ ...state, asks: state.asks.filter((ask) => ask.id !== id) })
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

  // Le harnais vient de compacter. On nettoie le fil comme le ferait son TUI :
  // l'historique est remplacé par le résumé qu'il a imprimé, et la fenêtre du
  // contexte repart de zéro jusqu'au prochain tour.
  window.zyvro.agent.onCompacted(({ id, summary }) => {
    compacting.add(id)
    const bound = turnToMessage.get(id)
    const threadId = bound?.threadId
    if (threadId === undefined) return
    mapThread(threadId, (t) => ({
      ...t,
      context: null,
      messages: [
        {
          id: nextMessageId(),
          role: "assistant",
          parts: [
            {
              kind: "text",
              text: summary.trim() || "Context compacted. The conversation continues from this summary.",
            },
          ],
          streaming: false,
        },
      ],
    }))
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
    // La fenêtre suit le dernier reçu : c'est lui qui a relu la conversation.
    // SAUF si le tour vient de compacter — son entrée est l'ancien contexte.
    const context = spent.context
    if (context !== undefined && !compacting.has(id)) {
      mapThread(bound.threadId, (t) => ({ ...t, context }))
    }
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
    mapMessage(bound.threadId, bound.messageId, (existing) => ended({ ...existing, error: message }))
    endTurn(id)
  })

  window.zyvro.agent.onDone(({ id }) => finishTurn(id))

  // Un message glissé vient d'être pris par l'agent : il quitte la file et
  // prend sa place dans le fil, là où l'agent l'a lu. Ce que l'agent dit
  // ensuite part dans une nouvelle réponse, sous lui — le même tour continue.
  window.zyvro.agent.onSteered(({ id, text }) => steered(id, text))
}

export function steered(turnId: string, text: string): void {
  const bound = turnToMessage.get(turnId)
  if (!bound) return
  const thread = threadById(bound.threadId)
  if (!thread) return
  const pris = thread.queued.find((q) => q.steering === true)
  const user: ChatMessage = { id: nextMessageId(), role: "user", parts: [{ kind: "text", text: pris?.text ?? text }], images: [], streaming: false }
  const suite: ChatMessage = { id: nextMessageId(), role: "assistant", parts: [], streaming: true, startedAt: Date.now() }
  mapThread(bound.threadId, (t) => ({
    ...t,
    queued: pris ? t.queued.filter((q) => q.id !== pris.id) : t.queued,
    messages: [
      // La réponse en cours s'arrête là ; vide, elle n'a rien à montrer.
      ...t.messages.flatMap((m) =>
        m.id !== bound.messageId ? [m] : m.parts.length === 0 && !m.error ? [] : [ended(m)]
      ),
      user,
      suite,
    ],
  }))
  turnToMessage.set(turnId, { threadId: bound.threadId, messageId: suite.id })
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
  mapMessage(bound.threadId, bound.messageId, ended)
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
// openInTerminal : la commande que le principal compose — il est le seul à
// connaître l'identifiant de session de la CLI — tapée dans le terminal, que
// l'on ouvre s'il est replié. Le shell a déjà les outils MCP de ce projet.
//
// MiMo Code a besoin des serveurs MCP du projet dans son environnement, qu'une
// ligne tapée ne peut pas lui donner : il s'ouvre dans un onglet à lui, qui les
// reçoit, et reprend la même conversation.
//
// Un onglet à lui, pour tous les harnais, et plus une ligne tapée dans le
// shell actif. La ligne attendait que ce shell existe : sans aucun shell
// ouvert (« No shell open. »), elle était jetée au bout de cinq secondes et le
// bouton ne faisait rien. Et quand il y en avait un, elle pouvait tomber dans
// un programme déjà lancé — un autre agent, un serveur. `agent:shell` lance le
// harnais lui-même, avec le modèle, les serveurs MCP du projet et la session
// de la conversation à reprendre.
async function openInTerminal(kind: AgentKind, threadId: string, model: string | null): Promise<void> {
  useWorkspace.getState().setPanel("terminal", true)
  askHarness(kind, model, threadId)
}

async function dispatch(threadId: string, text: string, images: Attached[]): Promise<void> {
  const thread = threadById(threadId)
  if (!thread) return

  const messageId = beginTurn(threadId, text, images)

  // Où l'agent travaille : le projet ouvert, ou le dossier d'accueil sans
  // projet. C'était `project` ici, et un envoi sans projet ouvert repartait en
  // silence — Entrée, « Send », et rien du tout, ni message ni erreur. Le
  // principal sait travailler sur le dossier d'accueil ; seul un moteur pas
  // encore prêt empêche l'envoi, et cela se dit.
  if (useWorkspace.getState().root === null) {
    failTurn(threadId, messageId, "The local engine is still starting. Try again in a moment.")
    return
  }

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
      agentPermission(),
      thread.advancedSkills,
      getSettings().agent
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
  const arrete = cancelled.has(id)
  cancelled.delete(id)
  compacting.delete(id)
  if (!bound) return
  mapThread(bound.threadId, (thread) =>
    thread.turnId === id ? { ...thread, turnId: null, busy: false } : thread
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
//
// Multi-projet : chaque projet garde SON état de conversations (fils, onglet
// actif) dans `chatByProject`. Basculer range le sortant et restaure l'entrant
// — un tour en vol continue de streaming dans le fil qui lui revient, même
// quand ce fil n'est plus à l'écran. `restore()` ne sert qu'à la première
// arrivée sur un projet (ou après un rechargement, quand la mémoire est vide).
const chatByProject = new Map<string, ChatState>()
let restoredFor: string | null = null
// Les projets dont les conversations ont fini d'être relues. Seuls ceux-là ont
// un état qui vaut d'être rangé : ranger le chat vide provisoire d'un projet
// quitté avant la fin de sa lecture ferait qu'au retour on ne le relirait plus.
const relus = new Set<string>()
useWorkspace.subscribe((workspace) => {
  const project = workspace.project?.project ?? null
  if (project === restoredFor) return
  // Le sortant se range — y compris ses tours en vol, dont les événements
  // continuent d'arriver et de mettre à jour `state` via `mapThread`. Il faut
  // donc ranger APRÈS la dernière mise à jour, c'est-à-dire maintenant, et
  // re-ranger à chaque commit tant qu'il est en vol… Non : `mapThread` écrit
  // dans `state`, et `state` devient celui de l'entrant. On garde donc les
  // tours liés par `turnToMessage` (global) et on accepte qu'un tour du
  // sortant mette à jour un fil absent de l'écran — `mapThread` est un no-op
  // sur un fil inconnu, et le persist au disque se fait quand même.
  //
  // En pratique : on range le sortant, on restaure l'entrant, et les tours du
  // sortant continuent dans le principal. Quand on revient, `chatByProject`
  // remonte le fil tel qu'il était — sauf les chunks arrivés entre-temps,
  // qui sont dans le transcript du principal et seront relus au prochain
  // `restore()` si la mémoire a été perdue. Pour les garder tout de suite,
  // `mapThread` met aussi à jour la copie rangée.
  if (restoredFor && relus.has(restoredFor)) chatByProject.set(restoredFor, state)
  restoredFor = project
  if (!project) {
    resetChat()
    return
  }
  const range = chatByProject.get(project)
  if (range) {
    commit(range)
    return
  }
  // Première arrivée sur ce projet : un chat vide TOUT DE SUITE, puis ses
  // conversations relues du disque. Sans ce vide, un projet qui n'en avait
  // encore aucune — le second qu'on ouvre, typiquement — gardait à l'écran le
  // chat du projet précédent, et ce qu'on y tapait partait dans le fil de
  // l'autre. Pas `resetChat()` : il délie aussi les tours en vol, y compris
  // ceux du projet qu'on vient de ranger, qui doivent continuer d'écrire.
  commit(blankState())
  void restore(project)
})

// chatState : l'état affiché, pour les vérifications (check-agent-projects).
export function chatState(): ChatState {
  return state
}

// blankState : un chat neuf, un seul onglet vide, sur le harnais et le modèle
// qu'on avait sous les yeux.
function blankState(): ChatState {
  const fresh = blankThread(activeThread()?.model ?? null, activeThread()?.kind ?? "claude")
  return { threads: [fresh], activeId: fresh.id, asks: state.asks }
}

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
    startedAt: Date.now(),
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
    endedAt: orphan.done || orphan.error !== "" ? message.endedAt ?? Date.now() : message.endedAt,
  }))
  // L'usage orphelin porte lui aussi la taille du contexte — sans ça, un tour
  // dont le reçu arrive avant le lien laisserait le % à sa valeur d'avant.
  const orphanContext = orphan.spent?.context
  if (orphanContext !== undefined && !compacting.has(turnId)) {
    mapThread(threadId, (t) => ({ ...t, context: orphanContext }))
  }
  if (orphan.done || orphan.error !== "") endTurn(turnId)
}

/** Fails a turn that never reached main at all, so nothing will stream for it. */
function failTurn(threadId: string, messageId: string, message: string): void {
  mapMessage(threadId, messageId, (existing) => ended({ ...existing, error: message }))
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
      startedAt: m.startedAt,
      endedAt: m.endedAt,
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

  const stamp = JSON.stringify({ messages, advancedSkills: thread.advancedSkills })
  if (stamp === thread.saved) return
  mapThread(threadId, (t) => ({ ...t, saved: stamp }))

  void window.zyvro.agent.remember({
    id: thread.id,
    advancedSkills: thread.advancedSkills,
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
export async function restore(project: string | null = restoredFor): Promise<void> {
  if (typeof window === "undefined" || !window.zyvro) return
  const all = await window.zyvro.agent.conversations()
  // On a pu basculer pendant la lecture : ces conversations sont celles du
  // projet qu'on a quitté, pas de celui qu'on regarde. Rien n'est affiché ; le
  // projet les relira en revenant, son état n'ayant pas été rangé.
  if (project !== restoredFor) return
  const usable = all.filter((c) => c.messages.length > 0)
  // Rien à relire n'est pas rien à faire : un tour peut tourner dans une
  // conversation qui n'a encore jamais été écrite sur le disque — le premier,
  // justement, celui qu'on lance avant de sauver un fichier.
  if (usable.length === 0) {
    if (project) relus.add(project)
    await reattach(project)
    return
  }

  const threads: Thread[] = usable.map((c) => ({
    id: c.id,
    advancedSkills: c.advancedSkills === true,
    title: c.title || "New chat",
    messages: c.messages.map((m) => ({
      id: nextMessageId(),
      role: m.role,
      parts: restoreParts(m),
      spent: m.spent,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
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
    // Les images jointes qui n'étaient pas encore parties (keepChips).
    images: chipsFor(c.id),
    // Une file en attente ne repart pas après la fermeture, et c'est voulu :
    // ces messages n'ont jamais été envoyés. Les relancer au prochain
    // démarrage les ferait partir tout seuls, longtemps après, sur un projet
    // peut-être rouvert pour autre chose — et chacun coûte un tour. Leur
    // texte, lui, revient dans la boîte (restoreQueued, plus bas).
    queued: [],
    // La fenêtre telle que le dernier reçu l'a mesurée, pour qu'une conversation
    // rouverte demain sache où elle en est sans attendre un tour.
    context: [...c.messages].reverse().find((m) => m.spent?.context !== undefined)?.spent?.context ?? null,
    // L'empreinte de ce qui est sur le disque, dans la forme où on l'écrirait :
    // sans ça, le premier tour réécrirait un transcript identique.
    saved: "",
  }))
  for (const thread of threads) restoreQueued(thread.id)
  commit({ threads, activeId: threads[0].id, asks: state.asks })
  if (project) relus.add(project)
  await reattach(project)
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
async function reattach(project: string | null = restoredFor): Promise<void> {
  // Le principal ne rend que les tours du projet actif ; si l'on a basculé
  // pendant la question, ce ne sont plus ceux de l'écran.
  const running = await window.zyvro.agent.running().catch(() => [])
  if (project !== restoredFor) return
  for (const { id, conversationId, prompt, startedAt } of running) {
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
    if (startedAt) mapMessage(conversationId, messageId, (message) => ({ ...message, startedAt }))
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
function answerAsk(id: string, allow: boolean, answers?: QuestionAnswers): void {
  commit({ ...state, asks: state.asks.filter((ask) => ask.id !== id) })
  void window.zyvro.agent.answerPermission(id, allow, answers)
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

// A new tab is a new conversation id, which is what makes it a new session: its
// first turn finds nothing to resume and the CLI starts fresh.
//
// New chats use the defaults configured in Settings. Existing chats keep
// their own agent and model, and skill routing always starts off.
function openThread(): void {
  const thread = blankThread()
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
  // Son brouillon part avec elle — et, si c'est la session vierge qui tient la
  // clé de son dossier, la copie par dossier aussi (sinon la session neuve
  // suivante la reprendrait). Une autre session vierge, elle, n'y touche pas :
  // `releaseBlank` n'agit que pour la propriétaire.
  forgetDraft(id)
  if (thread.messages.length === 0) releaseBlank(id, blankKey(useWorkspace.getState().root))

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

// Ce que la croix d'un onglet ferait perdre. Fermer efface le transcript sur
// le disque et le brouillon : un clic à côté de l'onglet visé suffisait à
// perdre une conversation entière, ou le long prompt qu'on y écrivait.
export function whatClosingLoses(thread: Pick<Thread, "messages" | "queued" | "images">, draft: string): string[] {
  const perdu: string[] = []
  if (thread.messages.length > 0) perdu.push("its transcript")
  if (draft.trim() !== "") perdu.push("the prompt you were writing")
  if (thread.queued.length > 0) perdu.push(thread.queued.length === 1 ? "1 queued message" : `${thread.queued.length} queued messages`)
  if (thread.images.length > 0) perdu.push(thread.images.length === 1 ? "1 attached image" : `${thread.images.length} attached images`)
  return perdu
}

// La croix : demander d'abord quand il y a quelque chose à perdre. Une session
// vide se ferme d'un clic, comme avant.
export async function requestCloseThread(id: string): Promise<boolean> {
  const thread = threadById(id)
  if (!thread) return false
  const perdu = whatClosingLoses(thread, draftFor(id))
  if (perdu.length > 0) {
    const liste = perdu.length === 1 ? perdu[0] : `${perdu.slice(0, -1).join(", ")} and ${perdu[perdu.length - 1]}`
    const ok = await askConfirm({
      title: `Close “${thread.title}”?`,
      label: `This deletes ${liste}. It cannot be undone.`,
      confirmLabel: "Close",
    })
    if (!ok) return false
  }
  closeThread(id)
  return true
}

/** Ctrl+C dans la boîte, pendant un tour, sans texte sélectionné. */
export function isStopKey(
  event: Pick<KeyboardEvent<HTMLTextAreaElement>, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & {
    currentTarget: { selectionStart: number | null; selectionEnd: number | null }
  },
  running: boolean
): boolean {
  if (!running || event.key.toLowerCase() !== "c") return false
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  return event.currentTarget.selectionStart === event.currentTarget.selectionEnd
}

function markCancelled(turnId: string): void {
  cancelled.add(turnId)
}

// releaseThread : le dernier recours de Stop.
//
// Le bouton Stop est montré tant que la conversation est occupée, mais il ne
// savait arrêter qu'un tour dont il connaissait l'identifiant. Un tour qui ne
// l'a jamais reçu — l'envoi n'a jamais répondu —, ou dont le lien s'est perdu
// en chemin, laissait « Writing… » à l'écran, et Stop ne faisait rien. Ici,
// ce que l'écran croit en cours s'arrête, quoi qu'il arrive au processus : un
// panneau qu'on peut toujours débloquer vaut mieux qu'un panneau exact.
//
// Ça ne devrait jamais servir. Quand ça sert, c'est un bug : il entre au
// journal du bouton bug, avec de quoi le retrouver.
function releaseThread(threadId: string, why: string): void {
  const thread = threadById(threadId)
  if (!thread) return
  reportIncident(
    "stuck-turn",
    `${why} — thread ${threadId}, turnId ${thread.turnId ?? "none"}, busy ${thread.busy}, streaming ${thread.messages.filter((m) => m.streaming).length}`
  )
  for (const [turnId, bound] of turnToMessage) if (bound.threadId === threadId) turnToMessage.delete(turnId)
  mapThread(threadId, (t) => ({
    ...t,
    turnId: null,
    busy: false,
    messages: t.messages.map((m) => (m.streaming ? ended(m) : m)),
  }))
  persist(threadId)
}

// stuck : l'écran croit encore cette conversation en cours.
function stuck(threadId: string, turnId: string | null): boolean {
  const thread = threadById(threadId)
  if (!thread) return false
  if (turnId !== null && thread.turnId === turnId) return true
  return thread.turnId === null && (thread.busy || thread.messages.some((m) => m.streaming))
}

// chatSnapshot : tout ce que le panneau croit, pour un rapport de bug.
//
// Les conversations telles qu'à l'écran, et les tables qui relient un tour à
// son message — c'est entre les deux que se perd un tour bloqué sur
// « Writing… ».
export function chatSnapshot(): Record<string, unknown> {
  return {
    activeId: state.activeId,
    asks: state.asks.map((ask) => ({ id: ask.id, tool: ask.tool, questions: ask.questions?.length ?? 0 })),
    threads: state.threads.map((t) => ({
      id: t.id,
      title: t.title,
      kind: t.kind,
      model: t.model,
      ranWith: t.ranWith,
      turnId: t.turnId,
      busy: t.busy,
      advancedSkills: t.advancedSkills,
      goal: t.goal,
      context: t.context,
      queued: t.queued.map((q) => ({ id: q.id, text: q.text, steering: q.steering, images: q.images.length })),
      messages: t.messages.map((m) => ({
        id: m.id,
        role: m.role,
        streaming: m.streaming,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        error: m.error,
        spent: m.spent,
        images: m.images?.length ?? 0,
        parts: m.parts.map((part) =>
          part.kind === "text"
            ? { kind: "text", text: part.text }
            : {
                kind: "tool",
                callId: part.call.callId,
                running: part.call.running,
                done: part.call.done,
                finished: part.call.finished,
                isError: part.call.isError,
                detail: part.call.detail.slice(0, 2000),
                output: part.call.output.slice(0, 4000),
              }
        ),
      })),
    })),
    turnToMessage: [...turnToMessage.entries()].map(([turnId, bound]) => ({ turnId, ...bound })),
    orphans: [...orphans.entries()].map(([turnId, o]) => ({ turnId, parts: o.parts.length, error: o.error, done: o.done })),
    cancelled: [...cancelled],
    compacting: [...compacting],
    listenersAttached: attached,
  }
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

// InstallBanner : le harnais choisi n'est pas sur cette machine.
//
// Dit avant d'écrire plutôt qu'après avoir envoyé : sans elle, on l'apprenait
// par l'erreur du premier tour, « not found… Install it with », à recopier
// dans un terminal. Le bouton fait ce que la phrase demandait. Sans npm, il
// n'y a rien à lancer : le lien mène à Node.js, qui l'apporte.
function InstallBanner({ kind, npm }: { kind: AgentKind; npm: boolean }): JSX.Element {
  const table = harness(kind)
  const via = kind === table.bin ? "" : ` (${kind} runs on ${table.bin})`
  // MiMo Code n'est pas sur npm : l'application le télécharge elle-même, sur
  // toutes les plateformes. Seuls les harnais npm ont besoin de npm.
  const runnable = table.installer ? true : npm
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded border border-amber-400/25 bg-amber-400/[0.07] px-2 py-1.5 text-[11px] text-amber-200/90">
      <span className="min-w-0 flex-1">
        <span className="font-mono">{table.bin}</span> is not installed on this machine{via}.
        {!runnable && " Installing it needs npm, which comes with Node.js."}
      </span>
      {runnable ? (
        <button
          type="button"
          onClick={() => installHarness(kind)}
          title={`Runs ${table.install} in a terminal tab`}
          className="flex shrink-0 items-center gap-1 rounded bg-amber-400/15 px-2 py-0.5 font-medium text-amber-100 transition-colors hover:bg-amber-400/25"
        >
          <Download className="h-3 w-3" />
          Install {table.bin}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void window.zyvro.openExternal(NODE_DOWNLOAD_URL)}
          className="flex shrink-0 items-center gap-1 rounded bg-amber-400/15 px-2 py-0.5 font-medium text-amber-100 transition-colors hover:bg-amber-400/25"
        >
          <Download className="h-3 w-3" />
          Get Node.js
        </button>
      )}
    </div>
  )
}

export function AgentPanel(): JSX.Element {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const project = useWorkspace((workspace) => workspace.project)
  // Pour ouvrir le panneau du bas quand on y envoie quelque chose.
  const setPanel = useWorkspace((workspace) => workspace.setPanel)
  const chat = useSyncExternalStore(subscribe, getSnapshot)
  const queryClient = useQueryClient()

  const thread = chat.threads.find((t) => t.id === chat.activeId) ?? chat.threads[0]
  const kind = thread.kind
  // Présent tant qu'on ne sait pas le contraire : une bannière qui clignote à
  // chaque ouverture du panneau, le temps que la réponse arrive, serait fausse.
  const installes = useHarnessesInstalled()
  const present = (option: AgentKind) => installes.data?.harnesses[option] ?? true
  // Une session « commencée » est une session qui a un fil côté CLI. C'est le
  // premier message envoyé qui le crée, pas le premier caractère tapé : tant
  // que rien n'est parti, tout se change encore.
  const started = thread.messages.length > 0
  const asks = chat.asks
  // Ce que l'agent a le droit de faire n'appartient ni à cette conversation ni
  // à ce projet : c'est une façon de travailler, et elle ne change pas selon le
  // dossier qu'on ouvre. Voir state/permission.ts.
  const projectDir = project?.project ?? null
  const permission = useSyncExternalStore(subscribePermission, agentPermission)
  // Le projet où partira ce qu'on tape : celui au premier plan de la fenêtre.
  const projet = useWorkspace((s) => s.project)
  // Lu une fois ici plutôt que dans chaque bulle : le réglage est le même pour
  // toute la fenêtre, et cent messages n'ont pas à s'abonner cent fois.
  const showSpent = useSyncExternalStore(subscribeUsage, usageShown, () => true)
  // Le brouillon de la session affichée, hors du composant (state/composer) :
  // fermer le panneau, changer de mode, de session ou de projet ne le perd plus,
  // et chaque session garde le sien.
  // Une session sans message garde aussi son brouillon sous une clé par
  // dossier (state/composer) : c'est elle qu'on retrouve après un redémarrage,
  // la session neuve n'ayant pas d'identifiant stable.
  const ouRoot = useWorkspace((workspace) => workspace.root)
  const blank = thread.messages.length === 0 ? blankKey(ouRoot) : null
  const draft = useSyncExternalStore(subscribeDrafts, () => draftShown(thread.id, blank), () => "")
  const setDraft = (next: string | ((actuel: string) => string)): void => {
    const id = thread.id
    const texte = typeof next === "function" ? next(draftShown(id, blank)) : next
    setDraftFor(id, texte)
    // Seulement si cette session tient la clé de son dossier : une autre
    // session vierge n'y touche pas.
    if (holdsBlank(id, blank)) setDraftFor(blank!, texte)
  }
  // Où est le curseur : une commande ne se complète que tant qu'on est dedans,
  // pas quand on est revenu écrire au milieu d'une phrase qui commence par une
  // barre oblique.
  const [caret, setCaret] = useState(0)

  const composer = useRef<HTMLTextAreaElement | null>(null)
  // La boîte prend la hauteur de son texte quand elle naît — un panneau rouvert,
  // un changement de mode — et quand la session affichée change, car le même
  // champ reçoit alors le brouillon d'une autre. Sans ça, un brouillon de cinq
  // lignes revenait dans une boîte d'une ligne : on n'en voyait que la première
  // et il avait l'air perdu.
  const poserComposer = useCallback((node: HTMLTextAreaElement | null) => {
    composer.current = node
    if (node) requestAnimationFrame(() => grow(node))
  }, [])
  const sessionVue = useRef(thread.id)
  if (sessionVue.current !== thread.id) {
    sessionVue.current = thread.id
    requestAnimationFrame(() => {
      if (composer.current) grow(composer.current)
    })
  }
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
    // Pas de condition de projet : sans projet, l'agent travaille sur le
    // dossier d'accueil (voir `dispatch`).
    if (text === "" && thread.images.length === 0) return
    const threadId = thread.id
    const images = thread.images

    // `/compact` tapé à la main ouvre le même cadran que le bouton : la
    // taille réelle n'est connue qu'au tour suivant, on ne la devine pas.
    if (/^\/compact\b/i.test(text)) {
      mapThread(threadId, (t) => ({ ...t, context: null }))
    }

    // La boîte se vide dans les deux cas : ce qu'on vient d'écrire est parti
    // quelque part, en vol ou en file, et le laisser à l'écran ferait croire
    // qu'il n'est pas parti. Et il rejoint l'historique, rappelable par ↑.
    rememberPrompt(prompt)
    leaveHistory(threadId)
    setDraft("")
    // Elle n'est plus neuve : la clé de son dossier revient à la prochaine.
    releaseBlank(threadId, blank)
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
    //
    // Avec Claude et Codex, il fait mieux qu'attendre : il est glissé dans le
    // tour en cours, que l'agent lit au prochain point d'arrêt — entre deux
    // outils — comme dans leur propre terminal. Il reste affiché dans la file
    // jusqu'à ce que l'agent le prenne (agent:steered), puis prend sa place dans
    // le fil. Refusé (tour fini entre-temps, harnais trop ancien), il redevient
    // un message en attente ordinaire.
    if (thread.busy) {
      const qid = nextMessageId()
      const glisse = canSteer(thread, text, images)
      mapThread(threadId, (t) => ({
        ...t,
        queued: [...t.queued, { id: qid, text, images, ...(glisse ? { steering: true } : {}) }],
      }))
      if (glisse && thread.turnId) {
        void window.zyvro.agent
          .steer(thread.turnId, text)
          .catch(() => false)
          .then((ok) => {
            if (ok) return
            mapThread(threadId, (t) => ({ ...t, queued: t.queued.map((q) => (q.id === qid ? { ...q, steering: false } : q)) }))
          })
      }
      return
    }

    await dispatch(threadId, text, images)
  }

  // L'auto-synthèse (shared/synthesize) : avant de partir, la demande est
  // réécrite selon le mode choisi. Soit elle part d'elle-même, soit elle revient
  // dans la boîte, et Entrée l'envoie telle quelle — ce qu'on vient de relire
  // n'est pas réécrit une seconde fois. « Undo » rend le texte d'origine, qui
  // part alors tel quel lui aussi.
  const [reecriture, setReecriture] = useState<{ busy: boolean; original: string | null; sortie: string | null; erreur: string }>({
    busy: false,
    original: null,
    sortie: null,
    erreur: "",
  })
  const reecrire = async (text: string): Promise<string | null> => {
    setReecriture((r) => ({ ...r, busy: true, erreur: "" }))
    try {
      return await window.zyvro.agent.synthesize(text, synthesisSettings().mode, kind)
    } catch (err) {
      setReecriture((r) => ({ ...r, erreur: (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }))
      return null
    } finally {
      setReecriture((r) => ({ ...r, busy: false }))
    }
  }
  const envoyer = async (prompt: string): Promise<void> => {
    const { mode, autoSend } = synthesisSettings()
    const text = prompt.trim()
    if (reecriture.busy) return
    if (mode === "off" || text === "" || text === reecriture.sortie) {
      setReecriture((r) => ({ ...r, original: null, sortie: null }))
      await send(prompt)
      return
    }
    const sortie = await reecrire(text)
    if (sortie === null) return
    if (autoSend) {
      setReecriture((r) => ({ ...r, original: null, sortie: null }))
      await send(sortie)
      return
    }
    setDraft(sortie)
    setReecriture((r) => ({ ...r, original: text, sortie }))
    requestAnimationFrame(() => {
      const node = composer.current
      if (node) grow(node)
    })
  }
  const reecrireMaintenant = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || synthesisSettings().mode === "off") return
    const sortie = await reecrire(text)
    if (sortie === null) return
    setDraft(sortie)
    setReecriture((r) => ({ ...r, original: text, sortie }))
  }

  // `sendQueued` : Ctrl+C avec des messages en attente. Comme dans le terminal
  // d'un agent, on interrompt ce qu'il fait pour lui dire la suite : le tour
  // s'arrête et le premier message en attente part aussitôt, au lieu de
  // revenir dans la boîte. Le bouton Stop, lui, arrête tout.
  const stop = (sendQueued = false): void => {
    const turnId = thread.turnId
    const threadId = thread.id
    // La file part d'ici, une seule fois, quand l'arrêt est réglé — tour fini
    // ou débloqué à la main. Pas depuis `endTurn` : un tour arrêté n'y fait
    // jamais avancer la file, et sa fin peut arriver avant comme après la
    // réponse de `cancel`. Partir de là-bas ferait voir à la vérification
    // « encore en cours ? » le message suivant, et le prendrait pour le tour
    // bloqué.
    const relancer = (): void => {
      if (sendQueued && !stuck(threadId, null)) advance(threadId, true)
    }
    if (turnId === null) {
      // Occupé sans tour connu : on arrête ce que le principal fait tourner
      // pour cette conversation, puis on rend la main quoi qu'il réponde.
      void window.zyvro.agent
        .running()
        .catch(() => [])
        .then(async (running) => {
          for (const r of running.filter((r) => r.conversationId === threadId)) {
            markCancelled(r.id)
            await window.zyvro.agent.cancel(r.id).catch(() => {})
          }
          if (stuck(threadId, null)) releaseThread(threadId, "Stop with no turn id")
          relancer()
        })
    } else {
      markCancelled(turnId)
      void window.zyvro.agent
        .cancel(turnId)
        .catch(() => {})
        .then(() => {
          // Also recover a stale UI whose process has already disappeared.
          if (turnToMessage.has(turnId)) finishTurn(turnId)
          // Et si l'écran y croit encore, il cesse d'y croire.
          if (stuck(threadId, turnId)) releaseThread(threadId, "Stop did not end the turn")
          relancer()
        })
    }
    if (sendQueued) return

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
    // Ctrl+C arrête l'agent qui travaille, comme dans son terminal. Seulement
    // sans sélection : sous Windows et Linux, Ctrl+C copie, et un texte
    // sélectionné doit rester copiable (sur Mac, copier est ⌘C).
    if (isStopKey(event, thread.busy)) {
      event.preventDefault()
      stop(thread.queued.length > 0)
      return
    }
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
    // Échap pendant qu'on navigue dans l'historique : retour à ce qu'on
    // écrivait, d'un coup, au lieu de redescendre ligne par ligne.
    if (event.key === "Escape" && inHistory(thread.id)) {
      const rendu = cancelHistory(thread.id)
      if (rendu !== null) {
        event.preventDefault()
        setDraft(rendu)
        return
      }
    }
    // ↑ et ↓ : l'historique des prompts, comme dans un terminal. Seulement
    // depuis une boîte vide (ou quand on y navigue déjà), le curseur sur la
    // première ligne pour remonter, sur la dernière pour redescendre : dans un
    // texte de plusieurs lignes, les flèches restent celles du texte.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const node = event.currentTarget
      const avant = node.value.slice(0, node.selectionStart ?? 0)
      const apres = node.value.slice(node.selectionEnd ?? node.value.length)
      const navigue = inHistory(thread.id)
      const permis =
        event.key === "ArrowUp" ? (draft === "" || navigue) && !avant.includes("\n") : navigue && !apres.includes("\n")
      if (permis) {
        const texte = stepHistory(thread.id, event.key === "ArrowUp" ? -1 : 1, draft)
        if (texte !== null) {
          event.preventDefault()
          setDraft(texte)
          requestAnimationFrame(() => {
            const champ = composer.current
            if (!champ) return
            champ.setSelectionRange(texte.length, texte.length)
            grow(champ)
          })
          return
        }
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return
    event.preventDefault()
    void envoyer(draft)
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
    // Pris APRÈS le rendu, pas pendant. Prendre est ce qu'un rendu n'a pas le
    // droit de faire : en développement React rend deux fois et jette le
    // premier passage, donc le chemin déposé était consommé par celui qu'on
    // jette et n'arrivait jamais dans le champ.
    window.queueMicrotask(() => {
      const texte = takeHandoff("agent")
      if (texte) insertPaths([texte])
    })
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

        {/* La même conversation dans l'interface du harnais lui-même, dans le
            terminal : ses commandes, ses raccourcis, un long travail suivi en
            plein écran. Reprise là où le panneau l'a laissée. */}
        <button
          type="button"
          onClick={() => void openInTerminal(kind, thread.id, thread.model)}
          title={started ? `Continue this session in the terminal (${kind})` : `Open ${kind} in the terminal`}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <SquareTerminal className="h-3.5 w-3.5" />
        </button>
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
                onClick={() => void requestCloseThread(t.id)}
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
                {/* Un menu, logo et nom : quatre mots côte à côte se lisaient un
                    par un ; une marque se reconnaît. */}
                <HarnessPicker kind={kind} onChange={(option) => setKind(thread.id, option)} installed={present} />
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
              {/* Et la porte de sortie : le même harnais, le même modèle, mais
                  dans son interface à lui.

                  Le panneau lance ces CLI en mode impression et redessine leur
                  flux — c'est ce qu'il faut pour tenir une conversation ici, et
                  ça reste une conversation redessinée. Leur propre interface est
                  bonne, et certaines personnes la préfèrent. Le bouton est ici,
                  sous les deux choix qu'il emporte, parce que c'est le moment où
                  l'on décide comment on va travailler.

                  Ce qu'il économise est tout le reste : le dossier, les serveurs
                  MCP du projet, et un modèle local qu'il faudrait autrement
                  viser à la main avec deux variables d'environnement. */}
              <button
                type="button"
                onClick={() => {
                  // Demander une chose et ne pas voir l'endroit où elle arrive
                  // est un défaut à soi seul : le panneau du bas s'ouvre, comme
                  // il s'ouvre quand on clique une session persistante.
                  setPanel("terminal", true)
                  askHarness(kind, thread.model)
                }}
                title={
                  thread.model
                    ? `Open ${kind} in a terminal, on ${thread.model}`
                    : `Open ${kind} in a terminal, on whatever it picks`
                }
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
              >
                <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  Open {kind} in a terminal{thread.model ? ` · ${thread.model}` : ""}
                </span>
              </button>
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
        {!present(kind) && <InstallBanner kind={kind} npm={installes.data?.npm ?? true} />}

        {asks.map((ask) =>
          ask.questions ? (
            <QuestionCard
              key={ask.id}
              questions={ask.questions}
              onSubmit={(answers) => answerAsk(ask.id, true, answers)}
              onSkip={() => answerAsk(ask.id, false)}
            />
          ) : (
            <AskCard key={ask.id} ask={ask} />
          )
        )}

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
                {q.steering && (
                  <span className="shrink-0 text-[10px] text-primary/80" data-steering>
                    sending into this turn…
                  </span>
                )}
                {q.images.length > 0 && q.text !== "" && (
                  <Paperclip className="mt-[1px] h-3 w-3 shrink-0 text-muted-foreground/70" />
                )}
                {!q.steering && (
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
                )}
              </div>
            ))}
            <p className="px-0.5 text-[10px] text-muted-foreground/70">
              {thread.queued.every((q) => q.steering)
                ? "The agent reads it at its next step, without waiting for the end of the turn."
                : `${thread.queued.length === 1 ? "Sent on its own" : "Sent one at a time"} when this turn ends.`}{" "}
              Stop puts {thread.queued.length === 1 ? "it" : "them"} back in the box.
            </p>
          </div>
        )}

        {(reecriture.busy || reecriture.erreur || (reecriture.original !== null && draft.trim() === reecriture.sortie)) && (
          <p className="mb-1 flex items-center gap-2 px-0.5 text-[11px] text-muted-foreground" data-synthesis-note>
            {reecriture.busy ? (
              <span>Rewriting your request…</span>
            ) : reecriture.erreur ? (
              <span className="text-destructive">{reecriture.erreur}</span>
            ) : (
              <>
                <span className="text-sky-300/90">Rewritten — read it, then press Enter to send.</span>
                <button
                  type="button"
                  className="underline decoration-dotted hover:text-foreground"
                  onClick={() => {
                    const original = reecriture.original ?? ""
                    setDraft(original)
                    // Rendu, il part tel quel : on ne le réécrit pas une seconde fois.
                    setReecriture((r) => ({ ...r, original: null, sortie: original }))
                  }}
                >
                  Undo
                </button>
              </>
            )}
          </p>
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
            ref={poserComposer}
            rows={1}
            value={draft}
            disabled={disabled}
            placeholder={disabled ? "Starting the local engine…" : `Ask ${kind}… (↑ for earlier prompts)`}
            onChange={(event) => {
              // Taper fait sortir de l'historique : le texte est de nouveau le sien.
              leaveHistory(thread.id)
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

          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {/* Ce que l'agent a le droit de faire, sous la question qu'on lui
                pose : c'est là qu'on hésite, et un réglage rangé dans une page
                de préférences est un réglage qu'on découvre en lisant
                « permission refusée » au milieu d'une réponse. */}
            {/* Où part le prompt. Avec plusieurs projets ouverts, c'est la
                première chose à vérifier avant d'envoyer. */}
            {projet && <PromptProject project={projet.project} name={projet.name} />}
            <PermissionPicker
              value={permission}
              kind={kind}
              disabled={disabled}
              onChange={(next) => setPermission(next)}
            />
            <SynthesisPicker
              disabled={disabled}
              busy={reecriture.busy}
              canRewrite={draft.trim() !== ""}
              onRewriteNow={() => void reecrireMaintenant()}
            />
            {settings.agent.advancedSkills && <SkillsButton
              kind={kind}
              active={thread.advancedSkills}
              settings={settings.agent}
              disabled={disabled || thread.busy || thread.queued.length > 0}
              onChange={(advancedSkills) => {
                mapThread(thread.id, (t) => ({ ...t, advancedSkills }))
                persist(thread.id)
              }}
            />}
            {/* Recycler le contexte avant une longue tâche : le pourcentage dit
                où en est la fenêtre du modèle, un clic lance `/compact` sur le
                harnais pour retomber bas et ne pas tomber sur une compaction
                automatique en plein milieu d'une grosse feature. */}
            <ContextCompact
              context={thread.context}
              model={thread.model}
              ranWith={thread.ranWith}
              hasCompact={toutes.some((n) => n.toLowerCase() === "compact")}
              disabled={disabled || thread.busy || !started}
              onCompact={() => {
                // `/compact` part tel quel, sans images ni auto-synthèse :
                // une commande locale n'est pas une question à réécrire, et
                // joindre une image à un compactage n'a aucun sens.
                //
                // La taille réelle n'est connue qu'au tour suivant — le
                // compactage lui-même relit l'ancien contexte — donc on
                // l'oublie plutôt que d'afficher un chiffre qui n'est plus
                // vrai.
                mapThread(thread.id, (t) => ({ ...t, context: null, images: [] }))
                void dispatch(thread.id, "/compact", [])
              }}
            />
            {/* Signaler un bug, là où il arrive : l'état complet part avec la
                description. Jamais grisé — c'est justement quand le panneau
                est bloqué qu'on en a besoin. */}
            <BugButton
              snapshot={() => ({
                chat: chatSnapshot(),
                root: useWorkspace.getState().root,
                permission: agentPermission(),
                agentSettings: getSettings().agent,
              })}
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
                onClick={() => stop()}
                title="Stop (Ctrl+C)"
                className="shrink-0 rounded-md bg-white/[0.08] p-1.5 text-foreground transition-colors hover:bg-white/[0.12]"
              >
                <Square className="h-3 w-3" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void envoyer(draft)}
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
      <div className="rounded-md border border-white/[0.06] border-l-2 border-l-[color:var(--zy-chat-user)] bg-white/[0.04] px-2.5 py-1.5 text-xs leading-relaxed text-foreground">
        <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--zy-chat-user)]">You</div>
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

  const tint = HARNESS_TINT[kind] ?? HARNESS_TINT.claude
  // Ce qu'il fait en ce moment, pour l'indicateur de fin : un outil en vol, du
  // texte déjà parti, ou rien encore.
  const dernier = message.parts[message.parts.length - 1]
  const verb = !message.streaming
    ? ""
    : dernier?.kind === "tool" && !dernier.call.finished
      ? dernier.call.running
      : message.parts.length === 0
        ? "Thinking"
        : "Writing"

  return (
    <div className="group/bulle px-0.5 text-xs leading-relaxed">
      <div className={cn("mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide", tint.text)}>
        <span className={cn("h-1.5 w-1.5 rounded-full", tint.dot, message.streaming && "zy-pulse")} aria-hidden />
        {kind}
        {!message.streaming && textOf(message).trim() !== "" ? <SpeakButton id={message.id} text={textOf(message)} /> : null}
      </div>

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
          <Markdown key={`x${index}`} text={part.text} className="zy-agent-md text-foreground" compact renderCode={renderCode} />
        ) : null
      )}

      {/* Tant qu'il produit : une étoile qui tourne, le verbe qui scintille, des
          points qui sautent — à la fin du message, là où le prochain mot va
          arriver. Un « Thinking… » gris et fixe ne disait pas si ça avançait. */}
      {message.streaming ? (
        <Working verb={verb} kind={kind}>
          {message.startedAt ? <Elapsed since={message.startedAt} /> : null}
        </Working>
      ) : null}

      {/* Ce que le tour a dépensé. Discret et sous la réponse : c'est une
          information qu'on va chercher, pas une qu'on subit — et elle
          s'éteint d'un clic dans la barre du bas. */}
      {/* Et combien de temps il a pris, sur la même ligne : « Cogitated for
          3s · done 23:55 ». */}
      {showSpent && (message.spent || (!message.streaming && message.startedAt && message.endedAt)) ? (
        <div
          className="mt-1 font-mono text-[10px] text-muted-foreground/70"
          title={message.spent ? detail(message.spent) : undefined}
        >
          {[
            message.spent ? `↑ ${compact(message.spent.input)} in · ↓ ${compact(message.spent.output)} out` : null,
            !message.streaming && message.startedAt && message.endedAt
              ? `Cogitated for ${formatDuration(message.endedAt - message.startedAt)} · done ${clockTime(message.endedAt)}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
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

// Elapsed : depuis combien de temps l'agent travaille, à côté du verbe. Une
// seconde par seconde, sur l'horloge que tout le panneau partage. Masqué aux
// lecteurs d'écran : l'indicateur est une région annoncée, et une durée qui
// change chaque seconde y parlerait sans arrêt.
function Elapsed({ since }: { since: number }): JSX.Element {
  const now = useSyncExternalStore(everySecond, () => Math.floor(Date.now() / 1000))
  return (
    <span className="font-mono text-[10px] text-muted-foreground/70" aria-hidden>
      {formatDuration(now * 1000 - since)}
    </span>
  )
}

// SpeakButton : lire la réponse à voix haute.
//
// Dans l'en-tête de la réponse, à droite du nom du harnais : au survol du
// message, et loin des lignes d'outils, qui ont leurs propres clics. Visible
// en permanence pendant la lecture, pour qu'on trouve où l'arrêter.
function SpeakButton({ id, text }: { id: string; text: string }): JSX.Element | null {
  const lu = useSyncExternalStore(subscribeSpeech, speakingId, () => null) === id
  if (!speechAvailable()) return null
  return (
    <button
      type="button"
      onClick={() => toggleSpeech(id, text)}
      title={lu ? "Stop reading" : "Read aloud"}
      aria-label={lu ? "Stop reading" : "Read aloud"}
      aria-pressed={lu}
      className={cn(
        "zy-speak ml-auto rounded p-0.5 normal-case text-muted-foreground transition-opacity hover:bg-white/[0.08] hover:text-foreground focus-visible:opacity-100",
        lu ? "text-foreground opacity-100" : "opacity-0 group-hover/bulle:opacity-100"
      )}
    >
      {lu ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
    </button>
  )
}

export default AgentPanel
