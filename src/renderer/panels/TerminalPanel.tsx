import { useCallback, useRef, useState, useSyncExternalStore } from "react"
import { Terminal, type ITheme } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Plus, RotateCcw, TerminalSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "../state/workspace"

// The integrated shell is where `claude` and `codex` actually run, so a session
// has to survive everything the UI does to it: switching tabs, resizing the
// panel, opening another shell. That rules out unmounting a hidden session, and
// it rules out rebuilding the xterm instance on re-render. Everything below is
// arranged around keeping one xterm alive per session key for as long as the
// tab exists.

// ---------------------------------------------------------------------------
// Session status store
// ---------------------------------------------------------------------------

// The pty id and the exit code both arrive from outside React — one from an
// `invoke` reply, the other from an IPC event — so they live in a module store
// read through useSyncExternalStore rather than being pushed into state from an
// effect. `generation` is what a Restart bumps: it is used as the React key of
// the terminal host node, so a restart unmounts the old node (running the
// callback ref's teardown) and mounts a fresh one.
type SessionStatus = {
  ptyId: string | null
  /** False when the main process fell back to pipes, which cannot be resized. */
  pty: boolean
  exitCode: number | null
  generation: number
}

const IDLE: SessionStatus = { ptyId: null, pty: true, exitCode: null, generation: 0 }

const statuses = new Map<string, SessionStatus>()
const listeners = new Map<string, Set<() => void>>()

// getSnapshot must return a cached value: building `{...}` here would hand
// React a new object on every call and re-render forever.
function readStatus(key: string): SessionStatus {
  return statuses.get(key) ?? IDLE
}

function subscribeStatus(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(key)
  }
}

function patchStatus(key: string, patch: Partial<SessionStatus>): void {
  statuses.set(key, { ...readStatus(key), ...patch })
  const set = listeners.get(key)
  if (!set) return
  for (const listener of [...set]) listener()
}

function forgetStatus(key: string): void {
  statuses.delete(key)
}

function restartSession(key: string): void {
  const current = readStatus(key)
  patchStatus(key, { ptyId: null, exitCode: null, generation: current.generation + 1 })
}

// Imperative handles for a live session, registered by the callback ref and
// dropped by its teardown. Activating a tab is a user action, so re-fitting the
// shell that just became visible belongs in the click handler.
type SessionHandle = { fit: () => void; focus: () => void }
const handles = new Map<string, SessionHandle>()

let sessionCounter = 0
function nextSessionKey(): string {
  sessionCounter += 1
  return `shell-${sessionCounter}`
}

// ---------------------------------------------------------------------------
// xterm wiring
// ---------------------------------------------------------------------------

const THEME: ITheme = {
  background: "#0b0b0f",
  foreground: "#e5e5ea",
  cursor: "#e5e5ea",
  cursorAccent: "#0b0b0f",
  selectionBackground: "#2c2c39",
  black: "#1a1a1f",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#f2cc60",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#76e3ea",
  white: "#c9c9d1",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#a7f3a0",
  brightYellow: "#ffd866",
  brightBlue: "#a5d6ff",
  brightMagenta: "#e2c5ff",
  brightCyan: "#a5f3f0",
  brightWhite: "#f5f5f7",
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

function hasSize(node: HTMLElement): boolean {
  return node.clientWidth > 0 && node.clientHeight > 0
}

// mountTerminal owns one shell end to end. It returns the teardown the callback
// ref runs when the node goes away, which is the only place a session is ever
// destroyed.
function mountTerminal(node: HTMLDivElement, key: string): () => void {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: FONT_STACK,
    fontSize: 12.5,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: THEME,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  // Links open in the user's browser rather than in a webview; an Electron
  // window navigating away from the app would take the whole IDE with it.
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      void window.zyvro.openExternal(uri)
    })
  )

  term.open(node)
  if (hasSize(node)) fitAddon.fit()

  let ptyId: string | null = null
  let disposed = false

  // A login shell prints its banner and prompt immediately, and those events
  // can reach the renderer before the `terminal:create` reply does. Buffering
  // every event until this session knows its own id is what keeps the first
  // prompt from disappearing; ids that are not ours are simply dropped, since
  // the session they belong to buffers them itself.
  const early: { id: string; data: string }[] = []
  let earlyExit: { id: string; code: number } | null = null

  const offData = window.zyvro.terminal.onData((payload) => {
    if (ptyId === null) {
      early.push(payload)
      return
    }
    if (payload.id === ptyId) term.write(payload.data)
  })

  const offExit = window.zyvro.terminal.onExit((payload) => {
    if (ptyId === null) {
      if (earlyExit === null) earlyExit = payload
      return
    }
    if (payload.id === ptyId) patchStatus(key, { exitCode: payload.code })
  })

  const input = term.onData((data) => {
    if (ptyId !== null) void window.zyvro.terminal.write(ptyId, data)
  })

  const pushSize = (): void => {
    if (!hasSize(node)) return
    fitAddon.fit()
    if (ptyId !== null) void window.zyvro.terminal.resize(ptyId, term.cols, term.rows)
  }

  // A hidden tab measures 0x0, and fitting against that collapses the terminal
  // to one column and corrupts the reflowed scrollback. Skipping the zero-size
  // callback also gives us the re-fit on show for free: unhiding the wrapper
  // resizes this node, which fires the observer again with a real size.
  const observer = new ResizeObserver(pushSize)
  observer.observe(node)

  handles.set(key, { fit: pushSize, focus: () => term.focus() })

  void window.zyvro.terminal
    .create(term.cols, term.rows)
    .then((session) => {
      if (disposed) {
        // The tab was closed while the shell was still being spawned. Nothing
        // is listening any more, so kill it rather than leak a login shell.
        void window.zyvro.terminal.dispose(session.id)
        return
      }
      ptyId = session.id
      patchStatus(key, { ptyId: session.id, pty: session.pty })
      // Ce que ce shell a de branché, écrit avant tout le reste : la sortie du
      // shell attend dans `early`, donc le bandeau reste au-dessus de la
      // première invite au lieu de tomber au milieu.
      if (session.banner) term.write(session.banner)
      for (const payload of early) {
        if (payload.id === session.id) term.write(payload.data)
      }
      early.length = 0
      const pendingExit = earlyExit
      earlyExit = null
      if (pendingExit !== null && pendingExit.id === session.id) {
        patchStatus(key, { exitCode: pendingExit.code })
      }
      term.focus()
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      term.write(`\r\n\x1b[31mCould not start a shell: ${message}\x1b[0m\r\n`)
    })

  return () => {
    disposed = true
    observer.disconnect()
    handles.delete(key)
    offData()
    offExit()
    input.dispose()
    if (ptyId !== null) void window.zyvro.terminal.dispose(ptyId)
    term.dispose()
  }
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

function TerminalSession({ sessionKey, active }: { sessionKey: string; active: boolean }): JSX.Element {
  const status = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeStatus(sessionKey, listener), [sessionKey]),
    useCallback(() => readStatus(sessionKey), [sessionKey])
  )

  // React 18 ignores a value returned from a callback ref, so the teardown is
  // parked here and invoked when the ref is called with null.
  const teardown = useRef<(() => void) | null>(null)

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        const run = teardown.current
        teardown.current = null
        run?.()
        return
      }
      teardown.current = mountTerminal(node, sessionKey)
    },
    [sessionKey]
  )

  return (
    <div className={cn("absolute inset-0 flex flex-col", !active && "hidden")}>
      {/* The React key is the restart mechanism: bumping the generation remounts
          this node, which runs the ref teardown and then a fresh mount. */}
      <div key={status.generation} ref={attach} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />

      {status.exitCode !== null ? (
        <div className="flex items-center gap-3 border-t border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-[11px]">
          <span className="text-muted-foreground">
            Shell exited with code{" "}
            <span className={cn("font-mono", status.exitCode === 0 ? "text-foreground" : "text-red-400")}>
              {status.exitCode}
            </span>
          </span>
          <button
            type="button"
            onClick={() => restartSession(sessionKey)}
            className="inline-flex items-center gap-1 rounded border border-white/[0.06] bg-white/[0.04] px-2 py-0.5 text-foreground transition-colors hover:bg-white/[0.08]"
          >
            <RotateCcw className="h-3 w-3" />
            Restart
          </button>
        </div>
      ) : null}

      {status.ptyId !== null && !status.pty ? (
        <div className="border-t border-white/[0.06] bg-white/[0.02] px-3 py-1 text-[11px] text-muted-foreground">
          Running without a native pty — the window size is fixed for this session.
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function TerminalPanel(): JSX.Element {
  const project = useWorkspace((state) => state.project)
  const projectDir = project?.project ?? null

  const [sessions, setSessions] = useState<string[]>([])
  const [activeKey, setActiveKey] = useState("")
  const [boundProject, setBoundProject] = useState<string | null>(null)

  // Adjusting state during render, not in an effect. A pty's cwd is fixed when
  // it spawns, so every shell belongs to exactly one project: opening or
  // closing a project has to discard the old sessions and start one in the new
  // directory. Calling setState here re-renders before anything is committed,
  // which is the supported way to react to a changed input.
  if (projectDir !== boundProject) {
    for (const key of sessions) forgetStatus(key)
    setBoundProject(projectDir)
    if (projectDir === null) {
      setSessions([])
      setActiveKey("")
    } else {
      const key = nextSessionKey()
      setSessions([key])
      setActiveKey(key)
    }
  }

  const activate = (key: string): void => {
    setActiveKey(key)
    // The wrapper is unhidden in this commit, so the fit has to wait for the
    // browser to give the node a size again.
    requestAnimationFrame(() => {
      const handle = handles.get(key)
      handle?.fit()
      handle?.focus()
    })
  }

  const addSession = (): void => {
    const key = nextSessionKey()
    setSessions((current) => [...current, key])
    setActiveKey(key)
  }

  const closeSession = (key: string): void => {
    setSessions((current) => {
      const index = current.indexOf(key)
      if (index < 0) return current
      const next = current.filter((item) => item !== key)
      if (key === activeKey) {
        const fallback = next[Math.min(index, next.length - 1)] ?? ""
        setActiveKey(fallback)
        if (fallback) requestAnimationFrame(() => handles.get(fallback)?.fit())
      }
      return next
    })
    forgetStatus(key)
  }

  if (projectDir === null) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-8 shrink-0 items-center border-b border-white/[0.06] px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          Terminal
        </div>
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          Open a project to start a shell here.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-1.5">
        {sessions.map((key, index) => {
          const isActive = key === activeKey
          return (
            <div
              key={key}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors",
                isActive
                  ? "bg-white/[0.06] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <button
                type="button"
                onClick={() => activate(key)}
                className="inline-flex items-center gap-1.5"
                title={`Shell ${index + 1}`}
              >
                <TerminalSquare className="h-3 w-3" />
                Shell {index + 1}
              </button>
              <button
                type="button"
                onClick={() => closeSession(key)}
                title="Close shell"
                className={cn(
                  "rounded p-0.5 text-muted-foreground transition-opacity hover:bg-white/[0.08] hover:text-foreground",
                  isActive ? "opacity-70" : "opacity-0 group-hover:opacity-70"
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={addSession}
          title="New shell"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Every session stays mounted. Hiding the wrapper (never the xterm host
          itself) keeps the instance, its pty and its scrollback alive. */}
      <div className="relative min-h-0 flex-1">
        {sessions.map((key) => (
          <TerminalSession key={key} sessionKey={key} active={key === activeKey} />
        ))}
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No shell open.
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default TerminalPanel
