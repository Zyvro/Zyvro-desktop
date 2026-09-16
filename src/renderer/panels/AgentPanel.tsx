import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUp, MessageSquarePlus, Square, Wrench, X } from "lucide-react"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { AgentKind, WorkflowRef } from "../../preload"
import { useWorkspace } from "../state/workspace"
import { ModelPicker } from "~/panels/ModelPicker"

// This panel runs the agent CLI that is already signed in on this machine, so
// the streaming arrives as IPC events rather than as a fetch. Those events are
// a subscription, which means a module-level store read through
// useSyncExternalStore — not an effect, and not component state poked from a
// listener.

export type ChatRole = "user" | "assistant"

export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  tools: string[]
  error?: string
  streaming: boolean
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
}

type ChatState = {
  threads: Thread[]
  activeId: string
}

// Events for a turn can reach the renderer before `agent:send` resolves with
// that turn's id, so anything that arrives for an unbound turn is parked here
// and replayed the moment the binding lands.
type Orphan = { text: string; tools: string[]; error: string; done: boolean }

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
  }
}

const first = blankThread()
let state: ChatState = { threads: [first], activeId: first.id }
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

  window.zyvro.agent.onText(({ id, text }) => {
    const bound = turnToMessage.get(id)
    if (bound === undefined) {
      orphanFor(id).text += text
      return
    }
    mapMessage(bound.threadId, bound.messageId, (message) => ({ ...message, text: message.text + text }))
  })

  window.zyvro.agent.onTool(({ id, tool }) => {
    const bound = turnToMessage.get(id)
    if (bound === undefined) {
      orphanFor(id).tools.push(tool)
      return
    }
    mapMessage(bound.threadId, bound.messageId, (message) => ({ ...message, tools: [...message.tools, tool] }))
  })

  // The model is reported for the thread that ran it, whichever tab is on
  // screen: a background turn that fell back to a different model should say so
  // in its own tab rather than in the one being read.
  window.zyvro.agent.onModel(({ conversationId, model }) => {
    const thread = threadById(conversationId)
    if (!thread || thread.ranWith === model) return
    mapThread(conversationId, (t) => ({ ...t, ranWith: model }))
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
    orphan = { text: "", tools: [], error: "", done: false }
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
function beginTurn(threadId: string, prompt: string): string {
  const assistantId = nextMessageId()
  const user: ChatMessage = {
    id: nextMessageId(),
    role: "user",
    text: prompt,
    tools: [],
    streaming: false,
  }
  const assistant: ChatMessage = {
    id: assistantId,
    role: "assistant",
    text: "",
    tools: [],
    streaming: true,
  }
  mapThread(threadId, (thread) => ({
    ...thread,
    // The tab is named after what was first asked of it, which is what a
    // person recognises in a row of tabs.
    title: thread.messages.length === 0 ? titleFrom(prompt) : thread.title,
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
    text: message.text + orphan.text,
    tools: orphan.tools.length > 0 ? [...message.tools, ...orphan.tools] : message.tools,
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
    .filter((m) => m.text !== "" || m.tools.length > 0 || m.error)
    .map((m) => ({ role: m.role, text: m.text, tools: m.tools, error: m.error }))
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
      text: m.text,
      tools: m.tools ?? [],
      error: m.error,
      streaming: false,
    })),
    turnId: null,
    busy: false,
    model: c.model ?? null,
    ranWith: c.ranWith ?? null,
    kind: c.kind,
    saved: JSON.stringify(
      c.messages.map((m) => ({ role: m.role, text: m.text, tools: m.tools, error: m.error }))
    ),
  }))
  commit({ threads, activeId: threads[0].id })
}

function setModel(threadId: string, model: string | null): void {
  mapThread(threadId, (thread) => ({ ...thread, model }))
}

function setKind(threadId: string, kind: AgentKind): void {
  mapThread(threadId, (thread) => ({ ...thread, kind }))
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
  commit({ threads: [...state.threads, thread], activeId: thread.id })
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
    commit({ threads: [fresh], activeId: fresh.id })
    return
  }
  // The neighbour on the left, which is what every editor does and what keeps
  // the eye near where it already was.
  const next = threads[Math.min(index, threads.length - 1)]
  commit({ threads, activeId: state.activeId === id ? next.id : state.activeId })
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
  commit({ threads: [fresh], activeId: fresh.id })
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
    if (text === "" || thread.busy || project === null) return
    const threadId = thread.id

    setDraft("")
    const node = composer.current
    if (node) node.style.height = ""

    const messageId = beginTurn(threadId, text)

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
      const turnId = await window.zyvro.agent.send(kind, text, workflows, threadId, thread.model)
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

  const disabled = project === null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] px-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Agent</span>

        <div className="ml-auto">
          <ModelPicker
            kind={kind}
            model={thread.model}
            ranWith={thread.ranWith}
            onChange={(model) => setModel(thread.id, model)}
          />
        </div>

        <div className="flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.04] p-0.5">
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
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
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
              <Bubble key={message.id} message={message} kind={kind} />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-white/[0.06] p-2">
        <div className="flex items-end gap-2 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1.5 focus-within:border-white/[0.12]">
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
            className="max-h-40 min-h-[20px] flex-1 resize-none bg-transparent text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />

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
  )
}

function Bubble({ message, kind }: { message: ChatMessage; kind: AgentKind }): JSX.Element {
  if (message.role === "user") {
    return (
      <div className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs leading-relaxed text-foreground">
        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">You</div>
        <div className="whitespace-pre-wrap break-words">{message.text}</div>
      </div>
    )
  }

  return (
    <div className="px-0.5 text-xs leading-relaxed">
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{kind}</div>

      {message.tools.length > 0 ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {message.tools.map((tool, index) => (
            <span
              key={`${tool}-${index}`}
              className="inline-flex items-center gap-1 rounded-full border border-white/[0.06] bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              <Wrench className="h-2.5 w-2.5" />
              ran {tool}
            </span>
          ))}
        </div>
      ) : null}

      {/* The assistant writes Markdown, so it is rendered as Markdown. The user's
          own message is left as plain text: they typed it, and reflowing their
          asterisks back at them as emphasis would be wrong. */}
      {message.text !== "" ? (
        <Markdown text={message.text} className="text-foreground" compact />
      ) : null}

      {message.streaming && message.text === "" && message.tools.length === 0 ? (
        <div className="text-muted-foreground">Thinking…</div>
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
