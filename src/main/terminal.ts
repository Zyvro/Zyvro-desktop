import { spawn as spawnPipe, type ChildProcess } from "node:child_process"
import os from "node:os"
import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"

// The integrated shell is not a convenience feature. `claude` and `codex` both
// change behaviour when stdout is not a terminal, and the whole point of the
// desktop app is that the user drives those tools. So we want a real PTY, and
// we only fall back to pipes when the native module is unavailable.

type PtyLike = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
  ): {
    write(d: string): void
    resize(c: number, r: number): void
    kill(): void
    onData(cb: (d: string) => void): void
    onExit(cb: (e: { exitCode: number }) => void): void
  }
}

let ptyModule: NodePtyModule | null | undefined

// loadPty resolves node-pty lazily and remembers the failure. A native module
// built for the wrong Electron ABI throws on require, and that must degrade the
// terminal rather than prevent the app from opening at all.
function loadPty(): NodePtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require("node-pty") as NodePtyModule
  } catch (err) {
    console.warn("node-pty unavailable, terminal runs in pipe mode:", (err as Error).message)
    ptyModule = null
  }
  return ptyModule
}

export function ptyAvailable(): boolean {
  return loadPty() !== null
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC || "cmd.exe", args: [] }
  }
  const shell = process.env.SHELL || "/bin/zsh"
  // A login shell is what picks up nvm, pyenv, homebrew and the PATH entry that
  // makes `claude` and `codex` resolvable at all.
  return { file: shell, args: ["-l"] }
}

function makePty(cwd: string, cols: number, rows: number): PtyLike {
  const mod = loadPty()
  const { file, args } = defaultShell()
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }

  if (mod) {
    const proc = mod.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env })
    return {
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill(),
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit((e) => cb(e.exitCode)),
    }
  }

  // Fallback. `script` is a system utility that allocates a real PTY and runs
  // the shell inside it, so `claude` and `codex` still see a terminal and keep
  // their interactive behaviour. What it cannot do is propagate a resize, so
  // the window size is fixed for the life of the session. Windows has no
  // equivalent, and there the shell genuinely runs on pipes.
  const useScript = process.platform !== "win32"
  const command = useScript ? "/usr/bin/script" : file
  const commandArgs = useScript
    ? process.platform === "darwin"
      ? ["-q", "/dev/null", file, ...args]
      : ["-qfc", [file, ...args].join(" "), "/dev/null"]
    : args

  const child: ChildProcess = spawnPipe(command, commandArgs, {
    cwd,
    env: { ...env, LINES: String(rows), COLUMNS: String(cols) },
  })
  return {
    write: (d) => child.stdin?.write(d),
    resize: () => undefined,
    kill: () => child.kill(),
    onData: (cb) => {
      child.stdout?.on("data", (b: Buffer) => cb(b.toString("utf8")))
      child.stderr?.on("data", (b: Buffer) => cb(b.toString("utf8")))
    },
    onExit: (cb) => child.on("exit", (code) => cb(code ?? 0)),
  }
}

type Session = { id: string; pty: PtyLike }

// Terminals owns every shell the window opened. It holds the WebContents so it
// can push output, and drops every session when the window goes away: an
// orphaned login shell per closed window would pile up invisibly.
export class Terminals {
  private sessions = new Map<string, Session>()

  create(target: WebContents, cwd: string, cols = 80, rows = 24): { id: string; pty: boolean } {
    const id = randomUUID()
    const pty = makePty(cwd || os.homedir(), cols, rows)
    this.sessions.set(id, { id, pty })

    pty.onData((data) => {
      if (target.isDestroyed()) return
      target.send("terminal:data", { id, data })
    })
    pty.onExit((code) => {
      this.sessions.delete(id)
      if (target.isDestroyed()) return
      target.send("terminal:exit", { id, code })
    })

    return { id, pty: ptyAvailable() }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(cols, rows)
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    session.pty.kill()
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }
}
