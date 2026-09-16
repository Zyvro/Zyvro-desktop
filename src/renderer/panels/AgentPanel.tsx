import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUp, MessageSquarePlus, Square, Wrench } from "lucide-react"
import { Markdown } from "@/components/Markdown"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import type { AgentKind, WorkflowRef } from "../../preload"
import { useWorkspace } from "../state/workspace"

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

type ChatState = {
  messages: ChatMessage[]
  /** The id main gave us for the turn in flight; Stop needs it. */
  turnId: string | null
  /** True from the moment the user sends, before the turn id is known. */
  busy: boolean
}

// Events for a turn can reach the renderer before `agent:send` resolves with
// that turn's id, so anything that arrives for an unbound turn is parked here
// and replayed the moment the binding lands.
type Orphan = { text: string; tools: string[]; error: string; done: boolean }

const WORKFLOWS_KEY = ["local", "workflows"] as const

let state: ChatState = { messages: [], turnId: null, busy: false }
const subscribers = new Set<() => void>()
const turnToMessage = new Map<string, string>()
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

function mapMessage(id: string, change: (message: ChatMessage) => ChatMessage): void {
  let touched = false
  const messages = state.messages.map((message) => {
    if (message.id !== id) return message
    touched = true
    return change(message)
  })
  if (!touched) return
  commit({ ...state, messages })
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
    const messageId = turnToMessage.get(id)
    if (messageId === undefined) {
      orphanFor(id).text += text
      return
    }
    mapMessage(messageId, (message) => ({ ...message, text: message.text + text }))
  })

  window.zyvro.agent.onTool(({ id, tool }) => {
    const messageId = turnToMessage.get(id)
    if (messageId === undefined) {
      orphanFor(id).tools.push(tool)
      return
    }
    mapMessage(messageId, (message) => ({ ...message, tools: [...message.tools, tool] }))
  })

  window.zyvro.agent.onError(({ id, message }) => {
    // A turn the user stopped exits non-zero, so main reports it as an error.
    // Showing "exited with code null" for a deliberate Stop would be noise.
    if (cancelled.has(id)) {
      finishTurn(id)
      return
    }
    const messageId = turnToMessage.get(id)
    if (messageId === undefined) {
      orphanFor(id).error = message
      return
    }
    mapMessage(messageId, (existing) => ({ ...existing, error: message, streaming: false }))
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
  const messageId = turnToMessage.get(id)
  if (messageId === undefined) {
    orphanFor(id).done = true
    return
  }
  mapMessage(messageId, (message) => ({ ...message, streaming: false }))
  endTurn(id)
}

function endTurn(id: string): void {
  turnToMessage.delete(id)
  orphans.delete(id)
  cancelled.delete(id)
  if (state.turnId !== id) return
  commit({ ...state, turnId: null, busy: false })
}

function subscribe(listener: () => void): () => void {
  ensureAttached()
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

/** Records the prompt and the assistant placeholder, and returns its id. */
function beginTurn(prompt: string): string {
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
  commit({ messages: [...state.messages, user, assistant], turnId: null, busy: true })
  return assistantId
}

function bindTurn(messageId: string, turnId: string): void {
  turnToMessage.set(turnId, messageId)
  commit({ ...state, turnId })

  const orphan = orphans.get(turnId)
  if (!orphan) return
  orphans.delete(turnId)
  if (cancelled.has(turnId)) {
    finishTurn(turnId)
    return
  }
  mapMessage(messageId, (message) => ({
    ...message,
    text: message.text + orphan.text,
    tools: orphan.tools.length > 0 ? [...message.tools, ...orphan.tools] : message.tools,
    error: orphan.error || message.error,
    streaming: !orphan.done && orphan.error === "",
  }))
  if (orphan.done || orphan.error !== "") endTurn(turnId)
}

/** Fails a turn that never reached main at all, so nothing will stream for it. */
function failTurn(messageId: string, message: string): void {
  mapMessage(messageId, (existing) => ({ ...existing, error: message, streaming: false }))
  commit({ ...state, turnId: null, busy: false })
}

function markCancelled(turnId: string): void {
  cancelled.add(turnId)
}

function resetChat(): void {
  turnToMessage.clear()
  orphans.clear()
  cancelled.clear()
  commit({ messages: [], turnId: null, busy: false })
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

  const [kind, setKind] = useState<AgentKind>("claude")
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
    if (text === "" || chat.busy || project === null) return

    setDraft("")
    const node = composer.current
    if (node) node.style.height = ""

    const messageId = beginTurn(text)

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
      const turnId = await window.zyvro.agent.send(kind, text, workflows)
      bindTurn(messageId, turnId)
    } catch (error: unknown) {
      failTurn(messageId, error instanceof Error ? error.message : String(error))
    }
  }

  const stop = (): void => {
    const turnId = chat.turnId
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

        <div className="ml-auto flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-white/[0.04] p-0.5">
          {(["claude", "codex"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
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
          onClick={resetChat}
          title="New chat"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {chat.messages.length === 0 ? (
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
            {chat.messages.map((message) => (
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

          {chat.busy ? (
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
