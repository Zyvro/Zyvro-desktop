// Le côté application de l'hôte de terminaux (ptyhost.ts).
//
// Une connexion par hôte, ouverte à la première demande. L'hôte de la version
// courante est lancé s'il n'est pas là — détaché, pour qu'il nous survive — et
// c'est lui qui reçoit les agents neufs. Ceux d'une version précédente (une
// mise à jour vient d'avoir lieu) restent chez l'hôte qui les a lancés : on
// les y retrouve pour s'y rattacher, on n'y lance plus rien.
//
// Un pty tenu par un hôte se présente ensuite exactement comme un pty local
// (`PtyLike`) : terminal.ts n'a qu'une chose à savoir de plus, que le fermer se
// fait de deux façons — se détacher (l'application s'en va, l'agent continue)
// ou le tuer (la croix de son onglet).
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { app } from "electron"
import type { Aim } from "../shared/harness"
import type { PtyLike } from "./ptySpawn"
import { INFO_FILE, infoFile, lineReader, type FromHost, type HostInfo, type HostSpawn, type ToHost } from "./ptyHostProtocol"

type KeyListener = {
  data: (data: string) => void
  exit: (code: number) => void
}

const CONNECT_TIMEOUT = 2500
const START_TIMEOUT = 8000

function dataDir(): string {
  return app.getPath("userData")
}

function readInfo(file: string): HostInfo | null {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as HostInfo
    return typeof info.socket === "string" && typeof info.token === "string" ? info : null
  } catch {
    return null
  }
}

/** Le script de l'hôte, à côté de celui-ci une fois construit (out/main/ptyhost.js). */
function hostScript(): string {
  return path.join(__dirname, "ptyhost.js")
}

/** Le processus vit-il encore ? Faux seulement quand le système dit qu'il n'existe pas. */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function connectTo(info: HostInfo, onMessage: (m: FromHost) => void, onClose: (socket: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.socket)
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    const timer = setTimeout(() => fail(new Error("The terminal host did not answer.")), CONNECT_TIMEOUT)
    socket.on("error", (err) => fail(err))
    socket.on(
      "data",
      lineReader<FromHost>((m) => {
        if (!settled && m.t === "hello") {
          settled = true
          clearTimeout(timer)
          resolve(socket)
          return
        }
        onMessage(m)
      })
    )
    socket.on("close", () => {
      clearTimeout(timer)
      if (!settled) fail(new Error("The terminal host closed the connection."))
      else onClose(socket)
    })
    socket.on("connect", () => socket.write(`${JSON.stringify({ t: "hello", token: info.token } satisfies ToHost)}\n`))
  })
}

class HostClient {
  private socket: net.Socket | null = null
  private connecting: Promise<net.Socket> | null = null
  private readonly listeners = new Map<string, KeyListener>()
  private readonly requests = new Map<number, (m: FromHost) => void>()
  private nextId = 1

  /**
   * `file` : le fichier où cet hôte dit où il écoute. `start` : de quoi le
   * lancer s'il n'est pas là — seulement pour l'hôte de la version courante.
   */
  constructor(
    readonly file: string,
    private readonly start: (() => void) | null
  ) {}

  /** Joindre l'hôte, en le lançant s'il le faut (et si on en a le droit). */
  connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async open(): Promise<net.Socket> {
    const attempt = async (): Promise<net.Socket | null> => {
      const info = readInfo(this.file)
      if (!info) return null
      try {
        return await connectTo(info, (m) => this.dispatch(m), (closed) => {
          // Seulement la connexion en cours : celle qu'on a rendue nous-mêmes
          // (un ancien hôte qu'on n'écoute plus) ne dit pas que l'hôte est tombé.
          if (closed === this.socket) this.lost()
        })
      } catch {
        return null
      }
    }
    let socket = await attempt()
    if (!socket && this.start) {
      const before = readInfo(this.file)?.pid
      this.start()
      const until = Date.now() + START_TIMEOUT
      while (!socket && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 150))
        // Le fichier d'un hôte mort traîne : on attend celui du nouveau.
        if (readInfo(this.file)?.pid === before) continue
        socket = await attempt()
      }
    }
    if (!socket) {
      // Un hôte d'une autre version qui ne répond plus ET dont le processus
      // n'existe plus est mort : son fichier n'a plus rien à dire. Vivant mais
      // lent (une machine chargée), on le garde — l'effacer rendait ses agents
      // injoignables pour de bon.
      if (!this.start && !pidAlive(readInfo(this.file)?.pid)) {
        try {
          unlinkSync(this.file)
        } catch {
          // Déjà parti.
        }
      }
      throw new Error(this.start ? "The terminal host could not be started." : "That terminal host is gone.")
    }
    this.socket = socket
    return socket
  }

  private lost(): void {
    this.socket = null
    // L'hôte est tombé : ses agents avec lui. Chaque onglet l'apprend comme une fin.
    const orphans = [...this.listeners.values()]
    this.listeners.clear()
    for (const listener of orphans) listener.exit(1)
    for (const resolve of this.requests.values()) resolve({ t: "error", message: "The terminal host went away." })
    this.requests.clear()
  }

  private dispatch(m: FromHost): void {
    if ((m.t === "list" || m.t === "gateway" || m.t === "error") && typeof m.id === "number") {
      const resolve = this.requests.get(m.id)
      this.requests.delete(m.id)
      resolve?.(m)
      return
    }
    if (!("key" in m) || typeof m.key !== "string") return
    const listener = this.listeners.get(m.key)
    if (!listener) return
    if (m.t === "replay" || m.t === "data") listener.data(m.data)
    else if (m.t === "error") listener.data(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`)
    else if (m.t === "exit" || m.t === "gone") {
      this.listeners.delete(m.key)
      listener.exit(m.t === "exit" ? m.code : 1)
      this.release()
    }
  }

  send(m: ToHost): void {
    const socket = this.socket
    if (!socket || socket.destroyed) return
    try {
      socket.write(`${JSON.stringify(m)}\n`)
    } catch {
      // La fin de la connexion arrivera par `close`.
    }
  }

  listen(key: string, listener: KeyListener): void {
    this.listeners.set(key, listener)
  }

  /** Ne plus écouter cette clé — seulement si c'est encore `listener` qui l'écoute. */
  forget(key: string, listener?: KeyListener): void {
    if (listener && this.listeners.get(key) !== listener) return
    this.listeners.delete(key)
    this.release()
  }

  /**
   * Rendre la connexion à un hôte d'une AUTRE version quand on n'y écoute plus
   * rien. Une connexion ouverte le garde en vie : interrogé à chaque reprise,
   * chaque hôte ancien restait là pour toujours, même sans plus aucun agent.
   */
  private release(): void {
    if (this.start || this.listeners.size > 0 || this.requests.size > 0 || this.connecting) return
    const socket = this.socket
    this.socket = null
    socket?.end()
  }

  async request(make: (id: number) => ToHost): Promise<FromHost> {
    await this.connect()
    const id = this.nextId++
    return new Promise((resolve) => {
      this.requests.set(id, resolve)
      this.send(make(id))
      setTimeout(() => {
        if (!this.requests.has(id)) return
        this.requests.delete(id)
        resolve({ t: "error", id, message: "The terminal host did not answer." })
      }, 5000).unref?.()
    })
  }

  /** Les agents vivants chez cet hôte ; vide s'il ne répond pas. */
  async alive(): Promise<string[]> {
    return (await this.census()).keys
  }

  /** Les agents vivants, et ceux qu'on a tués et qui meurent encore. */
  async census(): Promise<{ keys: string[]; dying: string[] }> {
    if (!readInfo(this.file)) return { keys: [], dying: [] }
    try {
      const answer = await this.request((id) => ({ t: "list", id }))
      return answer.t === "list" ? { keys: answer.keys, dying: answer.dying ?? [] } : { keys: [], dying: [] }
    } catch {
      return { keys: [], dying: [] }
    } finally {
      this.release()
    }
  }
}

let current: HostClient | null = null
const others = new Map<string, HostClient>()

/** L'hôte de cette version de l'application : celui qui reçoit les agents neufs. */
function currentHost(): HostClient {
  if (!current) {
    const version = app.getVersion()
    current = new HostClient(infoFile(dataDir(), version), () => {
      if (!existsSync(hostScript())) throw new Error("The terminal host is missing from this build.")
      const child = spawn(process.execPath, [hostScript()], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ZYVRO_PTYHOST_DIR: dataDir(), ZYVRO_PTYHOST_VERSION: version },
      })
      child.on("error", () => undefined)
      child.unref()
    })
  }
  return current
}

/** Tous les hôtes connus : le courant, et ceux qu'une version précédente a laissés. */
function allHosts(): HostClient[] {
  const mine = currentHost()
  let names: string[] = []
  try {
    names = readdirSync(dataDir()).filter((name) => INFO_FILE.test(name))
  } catch {
    // Pas de dossier : pas d'hôte.
  }
  for (const name of names) {
    const file = path.join(dataDir(), name)
    if (file === mine.file || others.has(file)) continue
    others.set(file, new HostClient(file, null))
  }
  return [mine, ...others.values()]
}

/** L'hôte qui tient cet agent vivant, s'il y en a un. */
async function ownerOf(key: string): Promise<HostClient | null> {
  for (const host of allHosts()) {
    if ((await host.alive()).includes(key)) return host
  }
  return null
}

/** Les agents encore vivants, tous hôtes confondus. On ne lance pas d'hôte pour répondre. */
export async function hostedAlive(): Promise<Set<string>> {
  const keys = new Set<string>()
  for (const host of allHosts()) for (const key of await host.alive()) keys.add(key)
  return keys
}

/** La passerelle de modèles tenue par l'hôte courant, avec cette visée enregistrée. */
export async function hostedGateway(key: string, aim: Aim): Promise<{ baseUrl: string; origin: string; token: string }> {
  const answer = await currentHost().request((id) => ({ t: "gateway", id, key, aim }))
  if (answer.t !== "gateway") throw new Error(answer.t === "error" ? answer.message : "The terminal host has no gateway.")
  return { baseUrl: answer.baseUrl, origin: answer.origin, token: answer.token }
}

/** Joindre l'hôte courant maintenant (pour échouer tôt, avant de créer l'onglet). */
export async function hostReady(): Promise<void> {
  await currentHost().connect()
}

/**
 * Arrêter pour de bon un agent tenu par un hôte, et attendre qu'il soit parti.
 *
 * Pour changer de modèle : la session est rouverte aussitôt, et se rattacher
 * à l'ancien processus — encore en train de mourir — garderait l'ancien modèle.
 */
export async function stopHosted(key: string): Promise<void> {
  const host = await ownerOf(key)
  if (!host) return
  await host.connect()
  host.send({ t: "kill", key })
  // L'hôte ne le donne plus pour vivant dès qu'il est tué — on ne s'y rattache
  // plus, un agent neuf peut prendre la clé — et le tue net s'il traîne. On
  // attend quand même sa fin : deux processus sur une même conversation
  // écriraient ensemble dans son fichier.
  const until = Date.now() + 4000
  while (Date.now() < until) {
    const { keys, dying } = await host.census()
    if (!keys.includes(key) && !dying.includes(key)) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

/**
 * Un pty tenu par un hôte, vu comme un pty local.
 *
 * `spawn` lance le programme chez l'hôte courant ; sans lui, on se rattache à
 * celui qui tourne déjà sous cette clé, chez l'hôte qui le tient, et cet hôte
 * rejoue ce qu'il a écrit.
 */
export function hostedPty(key: string, spawnWith: Omit<HostSpawn, "t" | "key"> | null): PtyLike {
  const dataCbs: ((d: string) => void)[] = []
  const exitCbs: ((code: number) => void)[] = []
  // `listening` : l'hôte où l'on écoute cette clé. `host` : le même, une fois
  // le lancement ou l'attache envoyé — avant, rien d'autre ne doit partir.
  let listening: HostClient | null = null
  let host: HostClient | null = null
  let done = false
  let detached = false
  let size: { cols: number; rows: number } | null = null
  // Ce qu'on tape pendant qu'on cherche l'hôte part dès qu'on l'a trouvé.
  const early: string[] = []
  const me: KeyListener = {
    data: (d) => {
      for (const cb of dataCbs) cb(d)
    },
    exit: (code) => finish(code),
  }
  const finish = (code: number): void => {
    if (done) return
    done = true
    listening?.forget(key, me)
    for (const cb of exitCbs) cb(code)
  }
  const find = async (): Promise<HostClient> => {
    if (spawnWith) {
      await currentHost().connect()
      return currentHost()
    }
    const owner = await ownerOf(key)
    if (!owner) throw new Error("This agent is no longer running.")
    return owner
  }
  void find()
    .then(async (found) => {
      if (detached || done) return
      // À l'écoute d'abord : une connexion à un ancien hôte sans personne à
      // l'écoute est rendue, et l'attache partirait dans le vide.
      listening = found
      found.listen(key, me)
      await found.connect()
      if (detached || done) {
        found.forget(key, me)
        return
      }
      found.send(spawnWith ? { t: "spawn", key, ...spawnWith } : { t: "attach", key })
      if (size) found.send({ t: "resize", key, ...size })
      for (const data of early.splice(0)) found.send({ t: "write", key, data })
      host = found
    })
    .catch((err: Error) => {
      for (const cb of dataCbs) cb(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`)
      finish(1)
    })
  return {
    pid: 0,
    write: (data) => {
      if (host) host.send({ t: "write", key, data })
      else if (!done) early.push(data)
    },
    resize: (cols, rows) => {
      size = { cols, rows }
      host?.send({ t: "resize", key, cols, rows })
    },
    // Tué ou détaché, ce pty n'écoute plus sa clé : la fin tardive de l'ancien
    // processus ne doit pas tomber sur l'onglet neuf qui la reprend.
    kill: () => {
      detached = true
      if (host) host.send({ t: "kill", key })
      // Pas encore attaché à un agent qui tourne déjà : on le tue quand même.
      // Un lancement pas encore envoyé, lui, ne partira plus.
      else if (!spawnWith) void stopHosted(key)
      listening?.forget(key, me)
    },
    detach: () => {
      detached = true
      host?.send({ t: "detach", key })
      listening?.forget(key, me)
    },
    onData: (cb) => {
      dataCbs.push(cb)
    },
    onExit: (cb) => {
      exitCbs.push(cb)
    },
  }
}
