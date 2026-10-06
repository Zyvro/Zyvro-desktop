import { useCallback, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { MessageSquarePlus, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentKind } from "../../shared/harness"

export type SessionChoice = {
  id: string
  title: string
  kind: AgentKind
  model: string | null
  busy: boolean
  pending: unknown
  queued: unknown[]
  messages: { error?: string }[]
}

export function sessionStatus(session: SessionChoice): string {
  if (session.busy) return "Running"
  if (session.pending) return "Scheduled"
  if (session.messages.at(-1)?.error) return "Error"
  return "Idle"
}

export function matchingSessions(sessions: SessionChoice[], query: string, running: boolean): SessionChoice[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return sessions.filter((session) => {
    if (running && !session.busy) return false
    const text = `${session.title} ${session.kind} ${session.model ?? ""}`.toLocaleLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** Find a conversation without squeezing more information into its tab. */
export function AgentSessions({ sessions, activeId, onSelect, onNew, onClose }: {
  sessions: SessionChoice[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [running, setRunning] = useState(false)
  const [choice, setChoice] = useState(() => Math.max(0, sessions.findIndex((session) => session.id === activeId)))
  const visible = matchingSessions(sessions, query, running)
  const index = Math.max(0, Math.min(choice, visible.length - 1))
  const focus = useCallback((node: HTMLInputElement | null) => node?.focus(), [])
  const follow = useCallback((node: HTMLButtonElement | null) => node?.scrollIntoView({ block: "nearest" }), [])

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="panel fixed left-1/2 top-[12%] z-50 flex max-h-[70vh] w-[580px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex items-center gap-2 px-4 pt-3">
            <Dialog.Title className="text-sm font-semibold">Agent sessions</Dialog.Title>
            <span className="text-xs text-muted-foreground">{sessions.length}</span>
            <Dialog.Close className="ml-auto rounded p-1 text-muted-foreground hover:bg-white/10" aria-label="Close session switcher">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="px-4 pb-3 pt-1 text-xs text-muted-foreground">
            Conversations in the current project. Switching keeps agents running.
          </Dialog.Description>

          <div className="flex items-center gap-2 border-y border-white/10 px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={focus}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setChoice(0) }}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
              placeholder="Search by name, agent or model"
              role="combobox"
              aria-label="Search agent sessions"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="agent-session-results"
              aria-activedescendant={visible.length ? `agent-session-choice-${index}` : undefined}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setChoice(Math.min(index + 1, Math.max(0, visible.length - 1)))
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setChoice(Math.max(index - 1, 0))
                } else if (event.key === "Enter" && visible[index]) {
                  event.preventDefault()
                  onSelect(visible[index].id)
                }
              }}
            />
          </div>

          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              aria-pressed={running}
              onClick={() => { setRunning(!running); setChoice(0) }}
              className={cn("rounded px-2 py-1 text-xs hover:bg-white/10", running ? "bg-primary/15 text-primary" : "text-muted-foreground")}
            >
              Running ({sessions.filter((session) => session.busy).length})
            </button>
            <button type="button" onClick={onNew} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-white/10">
              <MessageSquarePlus className="h-3.5 w-3.5" /> New session
            </button>
          </div>

          <div id="agent-session-results" role="listbox" aria-label="Agent sessions" className="zy-scroll min-h-0 overflow-y-auto pb-2">
            {visible.map((session, i) => {
              const status = sessionStatus(session)
              return (
                <button
                  key={session.id}
                  id={`agent-session-choice-${i}`}
                  ref={i === index ? follow : undefined}
                  role="option"
                  aria-selected={i === index}
                  tabIndex={-1}
                  onClick={() => onSelect(session.id)}
                  onMouseMove={() => setChoice(i)}
                  className={cn("flex w-full items-center gap-3 px-4 py-2 text-left", i === index ? "bg-white/[0.09]" : "hover:bg-white/[0.04]")}
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", session.busy ? "bg-primary" : status === "Error" ? "bg-destructive" : "bg-white/20")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" title={session.title}>{session.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {session.kind}{session.model ? ` · ${session.model}` : ""}{session.id === activeId ? " · Current" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    {status}
                    {session.queued.length > 0 && <span className="block">{session.queued.length} queued</span>}
                  </span>
                </button>
              )
            })}
            {visible.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {running && !query.trim() ? "No agents are running in this project." : "No matching sessions."}
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
