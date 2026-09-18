import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable } from "node:stream"
import { existsSync } from "node:fs"
import path from "node:path"
import { app } from "electron"

// The desktop app does not talk to zyv.ro. Every project gets its own local
// daemon process (`zyvrod`) that owns the .zyvro folder and runs the graph
// engine on this machine. That is what makes a ChatGPT or Claude subscription
// usable: the engine can shell out to the CLI the user already signed in to,
// and no credential ever leaves the laptop.

// The daemon gets no stdin: it is a server, not a filter, and leaving a pipe
// open would only give a bug somewhere a way to block it.
type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>

export type DaemonHandshake = {
  ready: true
  port: number
  token: string
  project: string
  // Added by newer engines. An older one sends nothing here, which reads as
  // "unknown" rather than as an error.
  version?: string
}

export type DaemonInfo = DaemonHandshake & { origin: string }

export class DaemonError extends Error {
  readonly detail: string
  constructor(message: string, detail = "") {
    super(message)
    this.detail = detail
  }
}

// bundledBinary looks for the zyvrod that shipped with this app, most specific
// place first. A packaged build carries it under resources/bin; a developer
// running from the repo has just built it into Zyvro-engine/bin.
export function bundledBinary(): string {
  const name = process.platform === "win32" ? "zyvrod.exe" : "zyvrod"
  const candidates = [
    process.env.ZYVROD_PATH,
    path.join(process.resourcesPath || "", "bin", name),
    path.join(app.getAppPath(), "..", "..", "Zyvro-engine", "bin", name),
    path.join(app.getAppPath(), "..", "Zyvro-engine", "bin", name),
  ].filter((p): p is string => Boolean(p))

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // Last resort: let the OS find it. Fails loudly at spawn if it cannot.
  return name
}

// Daemon owns one child process for one project folder. It is deliberately not
// a singleton: opening a second project window starts a second daemon, so the
// two projects cannot see each other's workflows.
export class Daemon {
  private child: DaemonProcess | null = null
  private info: DaemonInfo | null = null
  private log: string[] = []

  // engineVersion is the version of the binary currently serving this project,
  // read from the handshake. Older engines do not send one.
  private version = ""

  get current(): DaemonInfo | null {
    return this.info
  }

  get engineVersion(): string {
    return this.version
  }

  // recentLog returns the tail of the daemon's stderr, which is what we show
  // the user when startup fails. Without it a failure is a silent blank window.
  recentLog(): string {
    return this.log.join("\n")
  }

  // start launches the engine that shipped with this app, and only that one.
  //
  // There used to be an update channel: the app checked a server for a newer
  // engine, verified a signature and ran what it downloaded. It is gone. The
  // engine now travels with the build, so a new engine means a new version of
  // the app — which is one fewer signed channel to get right, one fewer key to
  // keep safe, and no executable fetched at runtime at all.
  async start(projectDir: string): Promise<DaemonInfo> {
    return this.launch(bundledBinary(), projectDir)
  }

  private async launch(bin: string, projectDir: string): Promise<DaemonInfo> {
    await this.stop()
    const child = spawn(bin, ["--project", projectDir, "--port", "0"], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child = child

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.log.push(line)
        // Keep the buffer bounded: a long session would otherwise grow it
        // without limit for output nobody reads until something breaks.
        if (this.log.length > 200) this.log.shift()
      }
    })

    const handshake = await this.readHandshake(child, bin)
    this.version = handshake.version || ""
    this.info = { ...handshake, origin: `http://127.0.0.1:${handshake.port}` }

    // Ce que le démarrage ne surveillait pas : la suite.
    //
    // `readHandshake` écoute bien `exit`, mais sa promesse est déjà tenue — son
    // garde `settled` rend ce chemin inerte dès que la poignée de main a
    // réussi. Donc un moteur qui meurt ensuite ne changeait RIEN : `info`
    // gardait le port et le jeton d'un processus qui n'existe plus, et
    // l'application continuait de les distribuer — au panneau, aux outils MCP
    // d'un agent, à la visée d'un harnais. Chacun échouait à sa manière, loin
    // de la cause.
    //
    // Un arrêt demandé ne passe pas par ici : `stop()` met `this.child` à null
    // avant de tuer, donc la comparaison ci-dessous l'écarte d'elle-même. Pas
    // besoin d'un drapeau — et pas d'alerte à chaque fermeture de projet.
    child.once("exit", (code) => {
      if (this.child !== child) return
      this.child = null
      this.info = null
      this.version = ""
      const reason = { code, log: this.recentLog() }
      for (const listener of this.stoppedListeners) listener(reason)
    })

    return this.info
  }

  // readHandshake waits for the single JSON line the daemon prints once it is
  // listening. Polling a port instead would race: bound is not the same as
  // ready, and we also need the token that line carries.
  private readHandshake(child: DaemonProcess, bin: string): Promise<DaemonHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = ""
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => {
          child.kill()
          reject(new DaemonError("The local Zyvro engine did not start in time.", this.recentLog()))
        })
      }, 15_000)

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf("\n")
        while (index >= 0) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line.startsWith("{")) {
            try {
              const parsed = JSON.parse(line) as DaemonHandshake
              if (parsed.ready && parsed.port && parsed.token) {
                finish(() => resolve(parsed))
                return
              }
            } catch {
              // Not the handshake line. The daemon is free to log other JSON.
            }
          }
          index = buffer.indexOf("\n")
        }
      })

      child.on("error", (err: NodeJS.ErrnoException) => {
        const hint =
          err.code === "ENOENT"
            ? `Could not find the local engine at "${bin}". Build it with: cd Zyvro-engine && go build -o bin/zyvrod ./cmd/zyvrod`
            : err.message
        finish(() => reject(new DaemonError("The local Zyvro engine could not be launched.", hint)))
      })

      child.on("exit", (code) => {
        finish(() =>
          reject(new DaemonError(`The local Zyvro engine exited with code ${code}.`, this.recentLog()))
        )
      })
    })
  }

  /**
   * onStopped : être prévenu quand le moteur meurt sans qu'on le lui demande.
   *
   * Effacer l'adresse d'un processus mort évite de mentir, mais ne dit rien à
   * personne : une fenêtre qui affiche « moteur local sur le port 50829 »
   * continuerait de l'afficher. C'est par là qu'elle l'apprend.
   */
  onStopped(listener: (reason: { code: number | null; log: string }) => void): void {
    this.stoppedListeners.push(listener)
  }

  private stoppedListeners: ((reason: { code: number | null; log: string }) => void)[] = []

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.info = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        // The daemon had its chance to shut down cleanly.
        child.kill("SIGKILL")
        resolve()
      }, 3000)
      child.once("exit", () => {
        clearTimeout(done)
        resolve()
      })
      child.kill("SIGTERM")
    })
  }
}
