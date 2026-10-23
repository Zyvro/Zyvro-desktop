// Lancer un programme dans un pseudo-terminal, sans rien d'Electron.
//
// Partagé par le processus principal (terminal.ts) et par l'hôte de terminaux
// (ptyhost.ts), qui tourne en Node pur, détaché de l'application, pour que des
// agents survivent à sa fermeture. Deux copies de ce repli par `script`
// finiraient par diverger, et c'est le genre de détail qui ne casse que sur
// la machine de quelqu'un d'autre.
import { spawn as spawnPipe, type ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

export type PtyLike = {
  /** Le processus du shell. Zéro quand on ne l'a pas — le repli par `script`
   *  lance un intermédiaire, et c'est son pid qu'on aurait, pas celui du
   *  shell. */
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
  /** Se détacher sans tuer : seulement pour un pty tenu par l'hôte (ptyhost). */
  detach?(): void
}

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
  ): {
    /** Le processus du shell, que node-pty expose. C'est lui qu'on interroge
     *  pour savoir dans quel dossier quelqu'un s'est déplacé. */
    readonly pid: number
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

// Le shell du panneau vit dans shell.ts : c'est un choix de la personne, pas un
// détail du pty. `$SHELL` reste le défaut, mais il n'est plus le seul mot.
/**
 * Ce qu'un pty lance à la place du shell de connexion.
 *
 * Deux choses s'en servent : la commande qui attache une session persistante,
 * et le harnais qu'on ouvre dans son interface à lui depuis le panneau de
 * l'agent. `env` est ce que la seconde a apporté — voir makePty.
 */
export type Command = { file: string; args: string[]; env?: Record<string, string> }

// `script -c` prend UNE chaîne que /bin/sh redécoupe : des arguments recollés par des espaces
// perdaient leurs espaces, leurs guillemets, leurs parenthèses — un prompt d'agent, un nom
// de modèle, tout ce qui n'est pas un mot simple. Chacun est donc cité.
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * Lancer `file args` dans un pty, avec cet environnement complet.
 */
export function spawnPty(cwd: string, cols: number, rows: number, env: NodeJS.ProcessEnv, file: string, args: string[]): PtyLike {
  const mod = loadPty()
  if (mod) {
    const proc = mod.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env })
    // Un pty dont le processus vient de mourir lève sur `write`, `resize` et `kill`
    // (EIO, EBADF, « already exited ») : la fenêtre n'a pas encore appris la fin, elle
    // écrit ou redimensionne un shell qui n'est plus là, et l'exception partait dans le
    // processus principal. Rien à faire d'une écriture dans le vide.
    const quiet = (what: string, run: () => void): void => {
      try {
        run()
      } catch (err) {
        console.warn(`[pty] ${what} on a finished shell: ${(err as Error).message}`)
      }
    }
    return {
      pid: proc.pid,
      write: (d) => quiet("write", () => proc.write(d)),
      resize: (c, r) => quiet("resize", () => proc.resize(c, r)),
      kill: () => quiet("kill", () => proc.kill()),
      onData: (cb) => proc.onData((d) => quiet("data", () => cb(d))),
      onExit: (cb) => proc.onExit((e) => quiet("exit", () => cb(e.exitCode))),
    }
  }

  // Fallback. `script` is a system utility that allocates a real PTY and runs
  // the shell inside it, so `claude` and `codex` still see a terminal and keep
  // their interactive behaviour. What it cannot do is propagate a resize, so
  // the window size is fixed for the life of the session. Windows has no
  // equivalent, and there the shell genuinely runs on pipes.
  const useScript = process.platform !== "win32"
  const lance = useScript ? "/usr/bin/script" : file
  const commandArgs = useScript
    ? process.platform === "darwin"
      ? ["-q", "/dev/null", file, ...args]
      : ["-qfc", [file, ...args].map(shellQuote).join(" "), "/dev/null"]
    : args

  const child: ChildProcess = spawnPipe(lance, commandArgs, {
    cwd,
    env: { ...env, LINES: String(rows), COLUMNS: String(cols) },
  })
  // Sans écouteur, un événement `error` fait tomber le processus principal : le
  // programme introuvable (ENOENT) et l'écriture dans un tuyau fermé (EPIPE) le sont
  // tous deux. L'un est une fin avec le code 127, l'autre un écho dans le vide.
  let spawnFailure: string | null = null
  child.on("error", (err) => {
    spawnFailure = err.message
  })
  child.stdin?.on("error", () => undefined)
  child.stdout?.on("error", () => undefined)
  child.stderr?.on("error", () => undefined)
  return {
    // Le repli lance `/usr/bin/script`, pas le shell : son pid ne dirait pas où
    // le shell se trouve. Mieux vaut zéro que le mauvais dossier.
    pid: 0,
    write: (d) => {
      if (child.stdin?.writable) child.stdin.write(d)
    },
    resize: () => undefined,
    kill: () => {
      try {
        child.kill()
      } catch {
        // Déjà parti.
      }
    },
    onData: (cb) => {
      // Un caractère de plusieurs octets peut arriver coupé entre deux morceaux : un
      // décodeur à état, par flux, plutôt que `toString` morceau par morceau.
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8")
        stream?.on("data", (b: Buffer) => {
          const text = decoder.write(b)
          if (text) cb(text)
        })
      }
    },
    onExit: (cb) => {
      let done = false
      const end = (code: number): void => {
        if (done) return
        done = true
        cb(code)
      }
      child.on("exit", (code) => end(code ?? 0))
      child.on("error", () => {
        if (spawnFailure !== null) end(127)
      })
    },
  }
}

