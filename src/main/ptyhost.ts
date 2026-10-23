// L'hôte de terminaux : ce qui garde les agents vivants quand Zyvro se ferme.
//
// Un agent lancé dans un onglet était un enfant de l'application : la quitter —
// pour une mise à jour, typiquement — le tuait au milieu de son travail, et il
// fallait attendre que tous aient fini avant de pouvoir redémarrer. Ici, les
// processus des agents appartiennent à ce petit programme Node, lancé détaché
// (sa propre session, aucun lien avec la fenêtre), et l'application n'en est
// que le client. Elle part : l'hôte garde les agents et ce qu'ils écrivent.
// Elle revient : elle se rattache, l'écran est rejoué, le travail a continué.
//
// C'est le modèle des terminaux persistants de VS Code, et pas celui de tmux ou
// screen : ceux-là sont des émulateurs de terminal à part entière, la molette y
// devient des flèches (l'historique de saisie de claude défile au lieu du
// texte), l'historique reste chez eux, et ils ne sont pas installés partout.
// Ici les octets passent tels quels — le terminal de l'onglet reste le seul.
//
// La passerelle de modèles (responses.ts) vit ici aussi : un agent détaché qui
// vise un fournisseur à travers elle doit continuer d'avoir son modèle pendant
// que l'application redémarre, et la retrouver à la même adresse ensuite.
//
// Lancé par `ELECTRON_RUN_AS_NODE=1 <électron> ptyhost.js` (ptyHostClient.ts).
// Il s'arrête de lui-même quand il n'a plus ni agent ni client.
import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import net from "node:net"
import { spawnPty, type PtyLike } from "./ptySpawn"
import { startGateway, type GatewayHandle } from "./responses"
import type { Aim } from "../shared/harness"
import { infoFile, lineReader, PROTOCOL, socketPath, type FromHost, type ToHost } from "./ptyHostProtocol"

const dataDir = process.env.ZYVRO_PTYHOST_DIR ?? ""
if (!dataDir) {
  console.error("ZYVRO_PTYHOST_DIR is required")
  process.exit(2)
}
mkdirSync(dataDir, { recursive: true })
const version = process.env.ZYVRO_PTYHOST_VERSION ?? "dev"

const logFile = `${dataDir}/ptyhost.log`
function log(line: string): void {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Un journal qu'on ne peut pas écrire ne doit pas arrêter les agents.
  }
}
// Un hôte qui tombe emporte tous les agents : rien ne doit le faire tomber.
process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err.message}`))
process.on("unhandledRejection", (err) => log(`unhandled: ${String(err)}`))
// Détaché, mais un signal de fin de session reste possible selon la plateforme.
process.on("SIGHUP", () => undefined)

// Ce qu'on garde de chaque agent pour le rejouer : de quoi redessiner l'écran
// et un bon morceau d'historique, sans grossir sans fin.
const KEEP = 1024 * 1024
// Un agent fini reste connu un moment : l'application qui revient doit
// apprendre qu'il s'est terminé, pas qu'il n'a jamais existé.
const KEEP_EXITED_MS = 10 * 60_000
// Plus d'agent et plus de client depuis ce temps : on s'en va.
const IDLE_MS = 60_000

type Hosted = {
  pty: PtyLike | null
  seen: string
  clients: Set<net.Socket>
  exited: number | null
  exitedAt: number
}

const token = randomBytes(24).toString("hex")
const sockets = new Set<net.Socket>()
const hosted = new Map<string, Hosted>()
let gateway: GatewayHandle | null = null
let idleSince = Date.now()

function send(socket: net.Socket, message: FromHost): void {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(message)}\n`)
  } catch {
    // Le client est parti entre-temps.
  }
}

function remember(entry: Hosted, data: string): void {
  entry.seen += data
  if (entry.seen.length <= KEEP) return
  const trop = entry.seen.length - KEEP
  const saut = entry.seen.indexOf("\n", trop)
  entry.seen = entry.seen.slice(saut === -1 ? trop : saut + 1)
}

function spawn(socket: net.Socket, m: Extract<ToHost, { t: "spawn" }>): void {
  const before = hosted.get(m.key)
  if (before && before.exited === null) {
    // Déjà vivant : on s'y rattache plutôt que de lancer un second processus
    // sur la même conversation.
    attach(socket, m.key)
    return
  }
  const entry: Hosted = { pty: null, seen: "", clients: new Set([socket]), exited: null, exitedAt: 0 }
  hosted.set(m.key, entry)
  try {
    entry.pty = spawnPty(m.cwd, m.cols, m.rows, m.env, m.file, m.args)
  } catch (err) {
    hosted.delete(m.key)
    send(socket, { t: "error", key: m.key, message: (err as Error).message })
    send(socket, { t: "exit", key: m.key, code: 127 })
    return
  }
  log(`spawn ${m.key} ${m.file}`)
  entry.pty.onData((data) => {
    remember(entry, data)
    for (const client of entry.clients) send(client, { t: "data", key: m.key, data })
  })
  entry.pty.onExit((code) => {
    entry.exited = code
    entry.exitedAt = Date.now()
    entry.pty = null
    log(`exit ${m.key} ${code}`)
    for (const client of entry.clients) send(client, { t: "exit", key: m.key, code })
    entry.clients.clear()
  })
}

function attach(socket: net.Socket, key: string): void {
  const entry = hosted.get(key)
  if (!entry) {
    send(socket, { t: "gone", key })
    return
  }
  send(socket, { t: "replay", key, data: entry.seen })
  if (entry.exited !== null) {
    send(socket, { t: "exit", key, code: entry.exited })
    return
  }
  entry.clients.add(socket)
}

async function aimGateway(socket: net.Socket, id: number, key: string, aim: unknown): Promise<void> {
  try {
    if (!gateway) gateway = await startGateway()
    gateway.aim(key, aim as Aim)
    send(socket, { t: "gateway", id, baseUrl: gateway.baseUrl, origin: gateway.origin, token: gateway.token })
  } catch (err) {
    send(socket, { t: "error", id, message: (err as Error).message })
  }
}

function handle(socket: net.Socket, m: ToHost): void {
  switch (m.t) {
    case "spawn":
      spawn(socket, m)
      return
    case "attach":
      attach(socket, m.key)
      return
    case "detach":
      hosted.get(m.key)?.clients.delete(socket)
      return
    case "write":
      hosted.get(m.key)?.pty?.write(m.data)
      return
    case "resize":
      if (m.cols > 0 && m.rows > 0) hosted.get(m.key)?.pty?.resize(m.cols, m.rows)
      return
    case "kill": {
      const entry = hosted.get(m.key)
      entry?.pty?.kill()
      return
    }
    case "list": {
      const keys = [...hosted.entries()].filter(([, e]) => e.exited === null).map(([key]) => key)
      send(socket, { t: "list", id: m.id, keys })
      return
    }
    case "gateway":
      void aimGateway(socket, m.id, m.key, m.aim)
      return
  }
}

const where = socketPath(dataDir, version)

const server = net.createServer((socket) => {
  let trusted = false
  socket.on("error", () => undefined)
  socket.on(
    "data",
    lineReader<ToHost>((m) => {
      if (!trusted) {
        // Le premier mot doit être le jeton : la socket est à la personne
        // seule, mais un jeton ne coûte rien et ferme la porte à un autre
        // programme du même compte qui tomberait dessus.
        if (m.t === "hello" && m.token === token) {
          trusted = true
          sockets.add(socket)
          send(socket, { t: "hello", v: PROTOCOL, pid: process.pid })
        } else {
          socket.destroy()
        }
        return
      }
      handle(socket, m)
    })
  )
  socket.on("close", () => {
    sockets.delete(socket)
    for (const entry of hosted.values()) entry.clients.delete(socket)
  })
})

server.on("error", (err) => {
  log(`listen failed: ${err.message}`)
  process.exit(1)
})

// Un hôte déjà là (deux lancements de l'application en même temps) : on lui
// laisse la place. Sinon la socket restante est celle d'un hôte mort.
const probe = net.connect(where)
probe.on("connect", () => {
  probe.destroy()
  log("another host is already listening; leaving")
  process.exit(0)
})
probe.on("error", () => {
  if (process.platform !== "win32") {
    try {
      unlinkSync(where)
    } catch {
      // Rien à enlever.
    }
  }
  server.listen(where, () => {
    if (process.platform !== "win32") {
      try {
        chmodSync(where, 0o600)
      } catch {
        // Le dossier temporaire de la personne reste à elle.
      }
    }
    // Écrit à côté puis renommé : l'application ne doit jamais lire un fichier à moitié.
    const file = infoFile(dataDir, version)
    writeFileSync(`${file}.partial`, JSON.stringify({ v: PROTOCOL, pid: process.pid, socket: where, token }), { mode: 0o600 })
    renameSync(`${file}.partial`, file)
    log(`listening on ${where} (pid ${process.pid})`)
  })
})

// Le ménage, et la fin quand plus personne n'a besoin de nous.
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of hosted) {
    if (entry.exited !== null && now - entry.exitedAt > KEEP_EXITED_MS) hosted.delete(key)
  }
  const vivants = [...hosted.values()].some((entry) => entry.exited === null)
  if (vivants || sockets.size > 0) {
    idleSince = now
    return
  }
  if (now - idleSince > IDLE_MS) {
    log("idle; exiting")
    try {
      unlinkSync(infoFile(dataDir, version))
    } catch {
      // Déjà parti.
    }
    gateway?.close()
    server.close()
    process.exit(0)
  }
}, 5000).unref?.()
// L'intervalle ci-dessus est détaché de la boucle : c'est le serveur qui nous tient en vie.
