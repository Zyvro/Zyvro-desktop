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

// Giving this app the environment the person has, on a machine it did not set
// up.
//
// The problem it exists for: the environment a GUI application gets is not the
// environment you have. On macOS, double-clicking an app launches it from
// launchd, which reads no shell profile at all — no .zshrc, no .zprofile, no
// .bash_profile. A packaged Zyvro Studio starts with about a dozen variables:
// PATH set to /usr/bin:/bin:/usr/sbin:/sbin, HOME, USER, SHELL, TMPDIR, and
// nothing else. Everything a package manager or a version manager installed is
// missing from PATH, and everything a profile exports — NVM_DIR,
// HOMEBREW_PREFIX, GOPATH, JAVA_HOME, LANG, the keys people keep in their shell
// configuration — is missing outright.
//
// So the app told people the CLI they use every day was "not on your PATH".
// True, and useless: it was on theirs. Then, once PATH alone was repaired, the
// terminal panel opened a shell that still knew none of their variables and the
// agents ran without them. Running the app from a terminal hides all of it,
// which is exactly how it survived every test — including mine.
//
// Three steps, in this order, because each is only needed when the one before
// was not enough.
//
//   1. Ask the shells the person configured for their whole environment, and
//      adopt what this process does not already have. A shell is the
//      definition of the answer; guessing directories and variable names would
//      be a second list, wrong differently on every machine.
//   2. Ask more than one of them. `SHELL` is the account's login shell, which
//      is not always the shell whose profile holds the configuration — see
//      candidateShells.
//   3. If a tool is still not found, ask the package managers where they put
//      things — `npm prefix -g` and `brew --prefix` answer for themselves —
//      and add that directory to PATH.
//
// The repair is always to this process's environment, never to something handed
// to one caller. Every child this app starts inherits it: the local engine
// resolving `claude` with exec.LookPath, the shells in the terminal panel, the
// agent, the commit-message CLI. Fixing the environment fixes all of them at
// once; handing an absolute path to one of them fixes one.

const isWindows = process.platform === "win32"

// On Windows a GUI process inherits the system and user PATH from the registry,
// which is where installers register themselves, so there is no login shell to
// ask and nothing to repair. What Windows needs instead is the extension: the
// thing called `claude` there is `claude.cmd`, and Node cannot spawn a .cmd
// without a shell.
const EXTENSIONS = isWindows ? [".cmd", ".exe", ".bat", ".ps1", ""] : [""]

const TIMEOUT_MS = 5000
const MARK = "__zyvro_env__"

// ZYVRO_DEBUG_ENV=1 prints what was recovered. Names and counts, never values:
// this environment carries API keys and a log is a file.
const DEBUG = process.env.ZYVRO_DEBUG_ENV === "1"

// ---------- step 1: the shells the person configured ----------

type ShellEnv = Record<string, string>

// What a shell answers about itself rather than about the person. TMPDIR is
// here because launchd already handed this process the per-user one, and the
// shell's answer is either the same string or a worse one.
const NOT_OURS = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TMPDIR", "ZYVRO_SHELL_PROBE"])

// candidateShells: every shell whose profile might hold the answer.
//
// `SHELL` is the account's login shell — what launchd hands a GUI process, and
// the honest first answer. It is not always the shell the person uses. A
// terminal emulator can be told to run another one (iTerm has a "Custom Shell"
// field, VS Code has terminal.integrated.defaultProfile), and then everything
// that makes their machine work lives in a profile the account shell never
// reads. That is the shape of the report this exists for: `chsh` said bash,
// iTerm was running zsh, and the whole configuration — brew, nvm, the keys —
// was in ~/.zshrc. The app asked bash, bash answered honestly, and the answer
// was a PATH with no node in it.
//
// From inside a GUI process there is nothing that distinguishes the two cases,
// so we ask all of them, in this order, and merge. Merging is safe in a way
// that choosing is not: nothing anyone said is discarded, the first shell asked
// wins any disagreement, and a machine with a single configured shell answers
// exactly what it answered before.
function candidateShells(): string[] {
  const out: string[] = []
  const add = (shell: string | undefined | null) => {
    if (!shell || out.includes(shell) || !existsSync(shell)) return
    out.push(shell)
  }
  add(process.env.SHELL)
  // The user record, which answers when the environment does not: a process
  // started by something other than launchd can have no SHELL at all.
  try {
    add(os.userInfo().shell)
  } catch {
    // No user record to read. The two below are still worth asking.
  }
  add("/bin/zsh")
  add("/bin/bash")
  return out
}

// readShellEnv asks one shell for its whole environment.
//
// Its whole environment, and not just PATH. PATH was the first thing found
// missing and so the first thing repaired, but it is one variable among all the
// ones a profile exports: NVM_DIR, HOMEBREW_PREFIX, GOPATH, JAVA_HOME, LANG,
// and every key the person keeps in their shell configuration. An app that
// repairs PATH alone still opens a terminal that is not the one they have, and
// still runs an agent that cannot reach what their own shell reaches — which is
// exactly how this was described: "the packaged version has no environment".
function readShellEnv(shell: string): Promise<ShellEnv | null> {
  return new Promise((resolve) => {
    // -l runs the login profile, -i the interactive one, because which of the
    // two holds the configuration depends on the shell and on how the person
    // set it up.
    //
    // `env -0` rather than `env`: a value is allowed to contain a newline, and
    // a reader that split on newlines would cut one variable in half and take
    // the rest of it for another.
    const child = spawn(shell, ["-ilc", `echo "${MARK}"; /usr/bin/env -0; echo "${MARK}"`], {
      env: { ...process.env, ZYVRO_SHELL_PROBE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    })

    let out = ""
    let settled = false
    const done = (value: ShellEnv | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill("SIGKILL")
      if (DEBUG) console.log(`[cli] ${shell}: ${value ? `${Object.keys(value).length} variables` : "no answer"}`)
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
      if (parts.length < 3) return done(null)
      const env: ShellEnv = {}
      for (const entry of parts[1].split("\0")) {
        // The first entry still carries the newline `echo` left behind, and the
        // last is whatever followed the final NUL.
        const line = entry.replace(/^\r?\n/, "")
        const at = line.indexOf("=")
        if (at <= 0) continue
        env[line.slice(0, at)] = line.slice(at + 1)
      }
      done(Object.keys(env).length > 0 ? env : null)
    })
  })
}

// adopt takes what the shells said and makes it this process's environment.
async function adopt(): Promise<void> {
  const shells = candidateShells()
  if (DEBUG) console.log(`[cli] asking: ${shells.join(", ") || "nothing"}`)
  // In parallel: each one runs a whole profile, and asking them in turn would
  // add those seconds together in front of the first window.
  const answers = (await Promise.all(shells.map(readShellEnv))).filter((env): env is ShellEnv => env !== null)

  const taken: string[] = []
  for (const answer of answers) {
    for (const [key, value] of Object.entries(answer)) {
      // PATH is merged rather than adopted, just below.
      if (key === "PATH" || NOT_OURS.has(key)) continue
      // Never overwrite. What this process already holds was given to it
      // deliberately — by launchd, by the terminal it was started from, by a
      // test — and a shell profile is the weaker claim of the two. It is also
      // what keeps the case that already worked working: started from a
      // terminal, the app keeps that terminal's environment exactly.
      if (process.env[key] !== undefined) continue
      process.env[key] = value
      taken.push(key)
    }
  }

  // PATH last and all at once, so the shells keep their order: merge puts what
  // arrives in front, and merging them one at a time would leave the last shell
  // asked ahead of the first.
  const fromShells = answers
    .map((answer) => answer.PATH)
    .filter(Boolean)
    .join(":")
  if (fromShells) process.env.PATH = merge(process.env.PATH ?? "", fromShells)

  if (DEBUG) {
    console.log(`[cli] adopted ${taken.length} variables: ${taken.join(", ") || "none"}`)
    console.log(`[cli] PATH is now ${(process.env.PATH ?? "").split(":").length} directories`)
  }
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
  if (!isWindows) await adopt()

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
export function launch(
  name: string,
  args: string[],
  options: SpawnOptions = {},
  // Comment l'installer, quand l'appelant le sait.
  //
  // « Install it and sign in » ne disait pas comment, et l'appelant, lui, le
  // sait : la table des harnais porte la commande depuis le début. Une phrase
  // qui constate un manque sans dire par où commencer est une phrase qui oblige
  // à aller chercher ailleurs ce que l'application avait sous la main.
  install = ""
): ChildProcess {
  const found = locate(name)
  if (!found) {
    // Spawning the bare name anyway would fail with ENOENT, which is the same
    // answer with less information. Callers turn this into the sentence the
    // user reads.
    throw new Error(
      `"${name}" was not found on this machine.` +
        (install ? ` Install it with: ${install} —` : "") +
        ` then sign in and reopen this panel.`
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
  options: Omit<SpawnOptions, "stdio"> = {},
  install = ""
): ChildProcessByStdio<Writable, Readable, Readable> {
  return launch(name, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }, install) as ChildProcessByStdio<
    Writable,
    Readable,
    Readable
  >
}

// installed is the cheap question the UI asks: is this thing here at all.
export function installed(name: string): boolean {
  return locate(name) !== null
}

// helpOf runs a tool's own --help and hands back what it printed.
//
// It exists so the app can read what a CLI says about itself rather than
// restate it. Cached for the life of the process: the answer cannot change
// while the app runs, and asking once per menu open would spawn a process
// every time somebody looked at a dropdown.
const helpCache = new Map<string, string>()

export function helpOf(name: string): string {
  const cached = helpCache.get(name)
  if (cached !== undefined) return cached
  const found = locate(name)
  if (!found) {
    helpCache.set(name, "")
    return ""
  }
  const result = spawnSync(found.file, ["--help"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    shell: found.needsShell,
  })
  // Some tools print their help on stderr, and a non-zero exit from --help is
  // common enough not to be treated as a failure.
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  helpCache.set(name, text)
  return text
}
