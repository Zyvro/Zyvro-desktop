// L'hôte de terminaux : des agents qui survivent à la fermeture de Zyvro.
//
// Demandé pour pouvoir mettre l'application à jour sans attendre que tous les
// agents aient fini. Les processus appartiennent à l'hôte (src/main/ptyhost.ts),
// l'application n'en est que le client. Ce qui casse en silence ici :
//
// 1. **Se déconnecter tue l'agent.** Le client qui part (l'application qui
//    quitte) doit laisser le processus tourner — c'est toute la fonction.
// 2. **Un rattachement sur un écran vide.** L'hôte rejoue ce que l'agent a
//    écrit ; sans ça, on revient sur une invite muette sans rien de ce qui
//    s'est passé.
// 3. **Deux processus sur la même conversation.** Un second `spawn` sur une
//    clé vivante doit se rattacher, pas lancer un double.
// 4. **N'importe qui peut parler à l'hôte.** Sans le jeton, la connexion est
//    coupée avant d'avoir pu lancer quoi que ce soit.
// 5. **La passerelle meurt avec l'application.** Elle vit dans l'hôte, à une
//    adresse stable, pour qu'un agent détaché garde son modèle.
//
//     node scripts/check-ptyhost.mjs
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

let failures = 0
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`)
  if (!ok) failures++
}

const work = mkdtempSync(path.join(tmpdir(), "zyvro-ptyhost-"))
const out = path.join(work, "ptyhost.cjs")
await build({
  entryPoints: ["src/main/ptyhost.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  external: ["node-pty", "electron"],
  logLevel: "silent",
})

const dataDir = path.join(work, "data")
// L'hôte tourne comme dans l'application : le binaire d'Electron en mode Node.
// C'est pour lui que node-pty est compilé ; un `node` ordinaire ne le charge pas
// et retombe sur le repli `script`, qui sous macOS refuse de tourner sans
// terminal. Sans Electron installé, `node` fait l'affaire là où le repli marche.
const require = createRequire(import.meta.url)
let runtime = process.execPath
try {
  const electron = require("electron")
  if (typeof electron === "string" && existsSync(electron)) runtime = electron
} catch {
  // Pas d'Electron : on garde node.
}
const asNode = { ELECTRON_RUN_AS_NODE: "1" }
const host = spawn(runtime, [out], { env: { ...process.env, ...asNode, ZYVRO_PTYHOST_DIR: dataDir, ZYVRO_PTYHOST_VERSION: "1.2.3-alpha.9" }, stdio: "ignore" })
// Le programme de l'agent : le même exécutable, donc présent partout, Windows compris.
const echo = (first) => ({
  file: runtime,
  args: ["-e", `process.stdout.write(${JSON.stringify(first + "\n")});process.stdin.on("data",(d)=>process.stdout.write(d))`],
  env: { ...process.env, ...asNode },
})
const infoPath = path.join(dataDir, "ptyhost-1.2.3-alpha.9.json")
for (let i = 0; i < 100 && !existsSync(infoPath); i++) await new Promise((r) => setTimeout(r, 50))
const info = JSON.parse(readFileSync(infoPath, "utf8"))
check("l'hôte dit où il écoute", typeof info.socket === "string" && info.token.length >= 32)

function client(token = info.token) {
  const socket = net.connect(info.socket)
  const messages = []
  const waiters = []
  let pending = ""
  socket.on("data", (chunk) => {
    pending += chunk.toString()
    let at
    while ((at = pending.indexOf("\n")) !== -1) {
      const m = JSON.parse(pending.slice(0, at))
      pending = pending.slice(at + 1)
      messages.push(m)
      for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
    }
  })
  const closed = new Promise((r) => socket.on("close", r))
  socket.on("error", () => undefined)
  const send = (m) => socket.write(`${JSON.stringify(m)}\n`)
  const until = (test, ms = 4000) =>
    new Promise((resolve) => {
      const found = messages.find(test)
      if (found) return resolve(found)
      const w = { test, resolve }
      waiters.push(w)
      setTimeout(() => { const i = waiters.indexOf(w); if (i !== -1) { waiters.splice(i, 1); resolve(null) } }, ms)
    })
  send({ t: "hello", token })
  return { socket, messages, send, until, closed }
}

const text = (c, key) => c.messages.filter((m) => m.key === key && (m.t === "data" || m.t === "replay")).map((m) => m.data).join("")

// 4. le jeton
const intrus = client("pas-le-bon")
await intrus.closed
check("**sans le jeton, la connexion est coupée**", !intrus.messages.some((m) => m.t === "hello"))

// lancer, écrire
const a = client()
check("le bon jeton est accueilli", Boolean(await a.until((m) => m.t === "hello")))
a.send({ t: "spawn", key: "agent-1", ...echo("pret"), cwd: work, cols: 80, rows: 24 })
await a.until((m) => m.t === "data" && m.data.includes("pret"))
a.send({ t: "write", key: "agent-1", data: "bonjour\n" })
await a.until(() => text(a, "agent-1").includes("bonjour"))
check("l'agent répond", text(a, "agent-1").includes("bonjour"))

// 1. se déconnecter ne tue pas
a.socket.destroy()
await new Promise((r) => setTimeout(r, 300))
const b = client()
await b.until((m) => m.t === "hello")
b.send({ t: "list", id: 1 })
const liste = await b.until((m) => m.t === "list")
check("**le client parti, l'agent tourne toujours**", liste?.keys.includes("agent-1"), JSON.stringify(liste))

// 2. rejeu
b.send({ t: "attach", key: "agent-1" })
const rejeu = await b.until((m) => m.t === "replay")
check("**le rattachement rejoue l'écran**", rejeu?.data.includes("pret") && rejeu.data.includes("bonjour"), JSON.stringify(rejeu))
b.send({ t: "write", key: "agent-1", data: "encore\n" })
check("et le flux reprend", Boolean(await b.until((m) => m.t === "data" && m.data.includes("encore"))))

// 3. pas de double
b.send({ t: "spawn", key: "agent-1", ...echo("DOUBLE"), cwd: work, cols: 80, rows: 24 })
await new Promise((r) => setTimeout(r, 400))
check("**un second lancement sur une clé vivante se rattache**", !text(b, "agent-1").includes("DOUBLE"))

// un agent qui finit
b.send({ t: "kill", key: "agent-1" })
check("tué, il le dit", Boolean(await b.until((m) => m.t === "exit" && m.key === "agent-1")))
b.send({ t: "list", id: 2 })
check("et il n'est plus vivant", !(await b.until((m) => m.t === "list" && m.id === 2))?.keys.includes("agent-1"))
b.send({ t: "attach", key: "agent-1" })
check("se rattacher à un agent fini apprend sa fin", Boolean(await b.until((m) => m.t === "exit" && m.key === "agent-1" && b.messages.filter((x) => x.t === "exit").length >= 2)))

// 5. passerelle
b.send({ t: "gateway", id: 3, key: "lm/mini", aim: { provider: "lmstudio", url: "http://127.0.0.1:1", key: "", model: "mini" } })
const g1 = await b.until((m) => m.t === "gateway" && m.id === 3)
b.send({ t: "gateway", id: 4, key: "lm/autre", aim: { provider: "lmstudio", url: "http://127.0.0.1:1", key: "", model: "autre" } })
const g2 = await b.until((m) => m.t === "gateway" && m.id === 4)
check("**la passerelle vit dans l'hôte, à une adresse stable**", Boolean(g1 && g2 && g1.origin === g2.origin && g1.token === g2.token), JSON.stringify([g1, g2]))
const reponse = g1 ? await fetch(`${g1.origin}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${g1.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "nope", messages: [], max_tokens: 1 }) }) : null
check("et elle répond", reponse?.status === 404)

b.socket.destroy()
host.kill()
rmSync(work, { recursive: true, force: true })

console.log(failures === 0 ? "\nLes agents survivent à l'application, et on les retrouve tels qu'ils étaient." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
