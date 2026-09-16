import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Finding the command line tools this app runs, on a machine it did not set up.
//
// The problem it exists for: the PATH a GUI application gets is not the PATH
// you have. On macOS, double-clicking an app launches it from launchd, which
// reads no shell profile at all — no .zshrc, no .zprofile. The process starts
// with the system default, and everything a package manager or a version
// manager installed is missing from it. `claude` and `codex` commonly live in
// ~/.local/bin, which is nowhere in that list.
//
// So the app told people the CLI they use every day was "not on your PATH".
// True, and useless: it was on theirs. Running the app from a terminal hid it
// completely, which is exactly how it survived every test — including mine.
//
// Two steps, in this order, because the second is only needed when the first
// was not enough.
//
//   1. Ask the login shell what its PATH is, and adopt it. The shell is the
//      definition of the answer; guessing directories would be a second list,
//      wrong differently on every machine.
//   2. If a tool is still not found, ask the package managers where they put
//      things — `npm prefix -g` and `brew --prefix` answer for themselves —
//      and add that directory to PATH.
//
// The repair is always to PATH, never to a path handed to one caller. Every
// child this app starts inherits the environment: the local engine resolving
// `claude` with exec.LookPath, the shells in the terminal panel, the agent, the
// commit-message CLI. Fixing PATH fixes all of them at once; handing an
// absolute path to one of them fixes one.

const isWindows = process.platform === "win32"

// On Windows a GUI process inherits the system and user PATH from the registry,
// which is where installers register themselves, so there is no login shell to
// ask and nothing to repair. What Windows needs instead is the extension: the
// thing called `claude` there is `claude.cmd`, and Node cannot spawn a .cmd
// without a shell.
const EXTENSIONS = isWindows ? [".cmd", ".exe", ".bat", ".ps1", ""] : [""]

const TIMEOUT_MS = 5000
const MARK = "__zyvro_env__"

// ---------- step 1: the login shell ----------

function readLoginShellPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh"
    // -l runs the login profile, -i the interactive one, because which of the
    // two holds PATH depends on the shell and on how the person set it up.
    const child = spawn(shell, ["-ilc", `echo "${MARK}"; printf '%s' "$PATH"; echo; echo "${MARK}"`], {
      env: { ...process.env, ZYVRO_SHELL_PROBE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    })

    let out = ""
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      resolve(value)
    }

    // A login shell runs the whole profile, and some profiles are slow. Waiting
    // forever would mean an app that never opens a window.
    const timer = setTimeout(() => done(null), TIMEOUT_MS)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", () => done(null))
    child.on("close", () => {
      // The delimiters exist because a profile prints things: banners,
      // version-manager chatter, a `fortune` somebody set up in 2014. A reader
      // that took the whole output would parse a greeting as a variable.
      const parts = out.split(MARK)
      done(parts.length >= 3 ? parts[1].trim() : null)
    })
  })
}

// merge keeps what the process already had and adds what the shell knows, in
// the shell's order and without duplicates.
//
// Merging rather than replacing matters for the case that hid this bug: an app
// launched from a terminal already has the right PATH, and throwing it away to
// re-derive it would break the one case that worked.
export function merge(current: string, incoming: string): string {
  const separator = isWindows ? ";" : ":"
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...incoming.split(separator), ...current.split(separator)]) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const key = isWindows ? trimmed.toLowerCase() : trimmed
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out.join(separator)
}

// ---------- step 2: where package managers put things ----------

function ask(command: string, args: string[]): string {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: TIMEOUT_MS, shell: isWindows })
    return result.status === 0 ? result.stdout.trim() : ""
  } catch {
    return ""
  }
}

// installRoots are the directories the tools that install these CLIs report as
// their own. Asked rather than assumed wherever the tool can answer: `npm` and
// `brew` know where they put things, and a hardcoded /opt/homebrew is wrong on
// an Intel Mac.
//
// The two that are not asked for — ~/.local/bin and ~/.bun/bin — are
// conventions rather than answers, and they are here because that is where the
// installer scripts for these two CLIs actually put them. That is a short list
// of two, written down because there is nobody to ask.
function installRoots(): string[] {
  const home = os.homedir()
  const roots: string[] = []

  const npmPrefix = ask("npm", ["prefix", "-g"])
  if (npmPrefix) roots.push(isWindows ? npmPrefix : path.join(npmPrefix, "bin"))

  if (!isWindows) {
    const brewPrefix = ask("brew", ["--prefix"])
    if (brewPrefix) roots.push(path.join(brewPrefix, "bin"))
    roots.push(path.join(home, ".local", "bin"), path.join(home, ".bun", "bin"))
  } else {
    // npm's global bin on Windows when the prefix could not be asked for, and
    // the directory `winget` and most installers use.
    roots.push(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm"))
    roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs"))
  }

  return roots.filter((root) => root && existsSync(root))
}

// ---------- finding one tool ----------

export type Found = { file: string; needsShell: boolean }

// locate answers with the file that would run, or null.
//
// It walks PATH itself rather than shelling out to `which` or `where.exe`,
// because both of those answer for the PATH *they* are given and this needs to
// answer for the PATH this process holds — and on Windows it has to try the
// extensions too, which `where` does only for PATHEXT entries it knows.
export function locate(name: string): Found | null {
  const separator = isWindows ? ";" : ":"
  for (const dir of (process.env.PATH ?? "").split(separator)) {
    const trimmed = dir.trim()
    if (!trimmed) continue
    for (const extension of EXTENSIONS) {
      const candidate = path.join(trimmed, name + extension)
      if (existsSync(candidate)) {
        // A .cmd or .bat is a script for the command interpreter, not an
        // executable: Node refuses to spawn one without a shell, and the
        // failure reads as "file not found" for a file that is right there.
        return { file: candidate, needsShell: /\.(cmd|bat|ps1)$/i.test(candidate) }
      }
    }
  }
  return null
}

// ---------- the one call at startup ----------

// prepare repairs PATH once, before anything is spawned. Before anything, and
// not later: every child inherits this environment the moment it starts, so a
// repair afterwards would fix some of them and not others.
export async function prepare(names: string[]): Promise<void> {
  if (!isWindows) {
    const fromShell = await readLoginShellPath()
    if (fromShell) process.env.PATH = merge(process.env.PATH ?? "", fromShell)
  }

  // Only now, and only for what is still missing. A machine where the shell
  // already answered needs none of this, and asking npm and brew for their
  // prefixes costs two processes.
  const missing = names.filter((name) => !locate(name))
  if (missing.length === 0) return

  const roots = installRoots()
  if (roots.length === 0) return
  process.env.PATH = merge(process.env.PATH ?? "", roots.join(isWindows ? ";" : ":"))
}

// launch runs one of these tools. It exists so the Windows rule — a .cmd needs
// a shell — lives in one place rather than in every caller that spawns a CLI.
export function launch(name: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const found = locate(name)
  if (!found) {
    // Spawning the bare name anyway would fail with ENOENT, which is the same
    // answer with less information. Callers turn this into the sentence the
    // user reads.
    throw new Error(
      `"${name}" was not found on this machine. Install it and sign in, then reopen this panel.`
    )
  }
  return spawn(found.file, args, { ...options, shell: found.needsShell })
}

// launchPiped is launch for the callers that talk to the process. It exists for
// the types rather than the behaviour: a spawn whose stdio is not known
// statically hands back possibly-null streams, and three callers writing `!`
// on every line would be three chances to write it where it is not true.
export function launchPiped(
  name: string,
  args: string[],
  options: Omit<SpawnOptions, "stdio"> = {}
): ChildProcessByStdio<Writable, Readable, Readable> {
  return launch(name, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessByStdio<
    Writable,
    Readable,
    Readable
  >
}

// installed is the cheap question the UI asks: is this thing here at all.
export function installed(name: string): boolean {
  return locate(name) !== null
}
