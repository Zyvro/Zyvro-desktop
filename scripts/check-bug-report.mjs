// Le bouton bug, et le Stop qui ne débloquait rien.
//
// Ce qui casse en silence ici :
//
// 1. **Un secret qui part.** L'état envoyé contient des conversations ; une clé
//    collée dans l'une d'elles partirait avec. Les formes connues sont masquées
//    avant l'envoi — et seulement elles : masquer une empreinte de commit ou un
//    hash de fichier rendrait le rapport illisible pour rien.
//
// 2. **Un rapport trop gros pour être reçu.** Le serveur refuse au-delà de
//    5 Mo d'état. Une longue conversation y arrive vite : on réduit, on ne
//    renonce pas.
//
// 3. **Un rapport perdu faute de compte.** Signé ou non, il part ; une clé
//    refusée ne le perd pas et ne déconnecte personne.
//
// 4. **Un Stop qui ne fait rien.** Le bouton est montré tant que la
//    conversation est occupée, mais il n'arrêtait qu'un tour dont il
//    connaissait l'identifiant : un tour qui ne l'avait jamais reçu laissait
//    « Writing… » à l'écran pour toujours.
//
//     node scripts/check-bug-report.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-bug-report-check")
mkdirSync(dir, { recursive: true })
const userData = mkdtempSync(path.join(os.tmpdir(), "zyvro-bug-"))
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, getVersion: () => "0.1.0-test", getLocale: () => "fr", isPackaged: false } }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/main/bugreport")}"\n` + `export { reportBug } from "${from("src/main/account")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
process.env.ZYVRO_STORE_ORIGIN = "http://store.test"
const m = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- masquer -------------------------------------------------------------------
{
  const secrets = [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "sk-proj-AbCdEfGhIjKlMnOpQrStUv",
    "zk_AbCdEfGhIjKlMnOpQrStUv",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456",
    "AKIAABCDEFGHIJKLMNOP",
    "0123456789abcdef0123456789abcdef0123456789abcdef",
    "-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----",
  ]
  for (const secret of secrets) {
    const out = m.redact(`avant ${secret} après`)
    check(`**masqué : ${secret.slice(0, 14)}…**`, !out.includes(secret) && out.includes("[redacted]") && out.startsWith("avant ") && out.endsWith(" après"), out)
  }
  check("un en-tête garde son schéma", m.redact("Authorization: Bearer abcdefghijklmnop.qrs") === "Authorization: Bearer [redacted]")
  const sha = "26944c4f1e2d3c4b5a6978877665544332211000"
  const sha256 = "04882bf41679d49d9af108657a1e5515bf04fdf2940d12c0d0b1e5d79dc53be8"
  check("**une empreinte de commit reste lisible**", m.redact(sha) === sha)
  check("un SHA-256 aussi", m.redact(sha256) === sha256)
  check("le texte ordinaire ne bouge pas", m.redact("Writing… Stop did nothing (task-skills)") === "Writing… Stop did nothing (task-skills)")
}

// ---- tenir dans la limite ------------------------------------------------------
{
  const gros = "x".repeat(20_000)
  const threads = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, messages: Array.from({ length: 30 }, () => ({ text: gros })) }))
  const text = m.fitState({ renderer: { chat: { activeId: "t3", threads } }, main: { turns: [{ lines: Array.from({ length: 40 }, () => gros) }] } })
  const state = JSON.parse(text)
  check("**un état trop gros est réduit sous la limite**", text.length <= 4_500_000, String(text.length))
  check("et le dit", state.trimmed === true)
  check("la conversation active garde le plus de messages", state.renderer.chat.threads.find((t) => t.id === "t3").messages.length >= 10)
  const petit = m.fitState({ renderer: { chat: { activeId: "a", threads: [{ id: "a", messages: [1, 2, 3] }] } } })
  check("un état qui tient part entier", !JSON.parse(petit).trimmed && JSON.parse(petit).renderer.chat.threads[0].messages.length === 3)
}

// ---- le journal ----------------------------------------------------------------
{
  const vus = []
  m.onIncident((n) => vus.push(n))
  const avant = m.unreportedIncidents()
  m.recordIncident("agent:claude", "exited with code 1")
  check("une erreur entre au journal et le compteur monte", m.unreportedIncidents() === avant + 1 && vus.at(-1) === avant + 1)
  for (let i = 0; i < 250; i++) m.recordIncident("x", "y")
  check("le journal est borné", m.incidentLog().length === 200)
  check("une erreur trop longue est coupée", (m.recordIncident("x", "z".repeat(10_000)), m.incidentLog().at(-1).message.length === 4000))
}

// ---- envoyer ---------------------------------------------------------------------
{
  let envoye = null
  const id = await m.sendBugReport(
    { kind: "manual", description: "bloqué sur Writing, ma clé sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", renderer: { chat: { threads: [] } } },
    { turns: [{ lines: ["Bearer abcdefghijklmnopqrstuvwxyz"] }] },
    async (body) => ((envoye = JSON.parse(body)), { id: "bug_1" })
  )
  check("**le rapport rend son identifiant**", id === "bug_1")
  check("la description part, masquée", envoye.description.startsWith("bloqué sur Writing") && !envoye.description.includes("sk-ant-"))
  check("**l'état part entier : app, principal, rendu, journal**", envoye.state.app?.version === "0.1.0-test" && Array.isArray(envoye.state.main.turns) && envoye.state.renderer.chat && envoye.state.incidents.length > 0)
  check("les lignes des tours sont masquées aussi", JSON.stringify(envoye.state).includes("Bearer [redacted]"))
  check("**le rapport parti, le compteur repart de zéro**", m.unreportedIncidents() === 0)
  check("la version et la plateforme voyagent à part", envoye.app_version === "0.1.0-test" && envoye.platform.includes(process.platform))
}

// ---- avec ou sans compte -------------------------------------------------------
{
  const appels = []
  let refuseCle = false
  globalThis.fetch = async (url, init) => {
    const auth = new Headers(init.headers).get("Authorization")
    appels.push({ url, auth })
    if (auth && refuseCle) return new Response(JSON.stringify({ error: "invalid or revoked API key" }), { status: 401 })
    return new Response(JSON.stringify({ id: "bug_2" }), { status: 201 })
  }
  await m.reportBug("{}")
  check("**sans compte, le rapport part quand même**", appels[0].url === "http://store.test/api/bug-reports" && appels[0].auth === null)

  writeFileSync(path.join(userData, "account.json"), JSON.stringify({ origin: "http://store.test", key: "zk_test", account: { id: "u", email: "e", name: "n" } }))
  // Le module garde la lecture en cache : on le recharge pour lire le compte.
  delete createRequire(import.meta.url).cache[realpathSync(path.join(dir, "h.cjs"))]
  const m2 = createRequire(import.meta.url)(path.join(dir, "h.cjs"))
  appels.length = 0
  await m2.reportBug("{}")
  check("signé, il part avec la clé", appels[0]?.auth === "Bearer zk_test", JSON.stringify(appels))
  appels.length = 0
  refuseCle = true
  const r = await m2.reportBug("{}")
  check("**une clé refusée ne perd pas le rapport : il repart sans elle**", appels.length === 2 && appels[1].auth === null && r.id === "bug_2", JSON.stringify(appels))
  check("et ne déconnecte personne", readFileSync(path.join(userData, "account.json"), "utf8").includes("zk_test"))
}

// ---- le Stop et le bouton --------------------------------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const stop = panel.slice(panel.indexOf("const stop = (sendQueued = false): void => {"), panel.indexOf("// « Stop » vide la file"))
  check("**Stop sans identifiant de tour ne sort plus sans rien faire**", !/if \(turnId === null\) return/.test(stop) && /releaseThread\(threadId, "Stop with no turn id"\)/.test(stop))
  check("il arrête ce que le principal fait tourner pour cette conversation", /r\.conversationId === threadId/.test(stop) && /agent\.cancel\(r\.id\)/.test(stop))
  check("**et si l'écran croit encore le tour en cours, il cesse d'y croire**", /stuck\(threadId, turnId\)\) releaseThread/.test(stop))
  check("Ctrl+C marche dès que la conversation est occupée", /isStopKey\(event, thread\.busy\)/.test(panel))
  check("un Stop forcé entre au journal : c'est un bug", /reportIncident\(\s*"stuck-turn"/.test(panel))
  check("**le bouton bug est dans la barre du composeur, avec l'état du panneau**", /<BugButton\s+snapshot=\{\(\) => \(\{\s*chat: chatSnapshot\(\)/.test(panel))
  const main = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check("**les exceptions du principal sont regardées sans changer leur effet**", /uncaughtExceptionMonitor/.test(main) && !/process\.on\("uncaughtException"/.test(main))
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  check("le rapport emporte les tours de chaque fenêtre", /ipcMain\.handle\("bug:report"/.test(ipc) && /debugSnapshot\(\)/.test(ipc))
}

console.log(
  failures === 0 ? "\nUn bug se signale d'un clic, avec l'état qui l'explique, et Stop débloque toujours le panneau." : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
