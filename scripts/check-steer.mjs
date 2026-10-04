// Parler à l'agent pendant qu'il travaille.
//
// Demandé : « comme dans Claude Code », un message écrit pendant un tour doit
// être lu par l'agent tout de suite — entre deux outils — et pas à la fin du
// tour. Pour Claude et Codex ; qwen et MiMo gardent la file.
//
// Ce qui a été MESURÉ sur les vrais binaires (claude 2.1.288, codex 0.159.1),
// et que les faux harnais de ce script reproduisent :
//
// · Claude `-p --input-format stream-json` : une ligne écrite sur l'entrée en
//   plein tour est lue après le résultat de l'outil en cours ; le modèle change
//   de plan ; UN seul résultat. `--replay-user-messages` la renvoie
//   (`isReplay: true`) quand elle est prise. Écrite quand il n'y a plus de point
//   d'arrêt (réponse finale sans outil), elle ouvre un SECOND tour dans le même
//   processus. Le premier résultat annonce `queued_turn_count: 0` même alors :
//   le compteur ne dit pas tout. Et un message déjà écrit est traité même si
//   l'entrée se ferme ensuite (mesuré) : la garder ouverte jusqu'à l'accusé est
//   une sûreté, pas une condition.
// · Codex `exec` : `codex queue` range le message, mais exec ne le relève qu'à
//   la fin, démarre une tâche avec et sort sans répondre — message PERDU. Donc
//   pas exec : `codex app-server` et `turn/steer`, qui le glisse dans le tour
//   (accusé : un `userMessage`).
//
//     node scripts/check-steer.mjs
import { build } from "esbuild"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-steer-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(os.tmpdir())}, isPackaged: false } }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { translateNotification, newTranslateState, CodexServerTurn, codexServerPolicy, codexInput } from "${from("src/main/codexserver")}"\n` +
    `export { argsFor, claudeUserLine, configPairs, replayText, AgentRunner } from "${from("src/main/agent")}"\n`
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
const m = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- Claude : les arguments et la ligne d'entrée ---------------------------
{
  const args = m.argsFor("claude", { projectDir: "/p", workflows: [] }, null).join(" ")
  check("**Claude lit son entrée en flux et renvoie ce qu'il prend**", args.includes("--input-format stream-json") && args.includes("--replay-user-messages"))
  const ligne = JSON.parse(m.claudeUserLine("bonjour"))
  check("une question est une ligne JSON `user`", ligne.type === "user" && ligne.message.content[0].text === "bonjour" && m.claudeUserLine("x").endsWith("\n"))
  check("le texte d'une reprise se relit", m.replayText({ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }) === "ab")
}

// Print-mode Chrome must follow the saved preference; native skills stay enabled.
{
  const config = mkdtempSync(path.join(os.tmpdir(), "zyvro-claude-settings-"))
  const oldConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  try {
    for (const enabled of [true, false]) {
      writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ claudeInChromeDefaultEnabled: enabled }))
      const args = m.argsFor("claude", { projectDir: "/p", workflows: [], advancedSkills: false }, null)
      check(`Chrome default ${enabled} is respected in print mode`, args.includes("--chrome") === enabled)
      check("Native skills and plugins are not disabled with Zyvro's catalog off", !args.includes("--bare") && !args.includes("--disable-slash-commands") && !args.includes("--setting-sources"))
    }
  } finally {
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = oldConfig
    rmSync(config, { recursive: true, force: true })
  }
}

// ---- Codex : la traduction du serveur en flux exec ----------------------------
{
  const st = m.newTranslateState()
  const t = (method, params) => m.translateNotification(method, params, st)
  check("la question du tour n'est pas un message glissé", t("item/completed", { item: { type: "userMessage", content: [{ type: "text", text: "q" }] } }).length === 0)
  const glisse = t("item/completed", { item: { type: "userMessage", content: [{ type: "text", text: "change de plan" }] } })
  check("**le suivant est l'accusé d'un message glissé**", glisse[0]?.type === "zyvro.steered" && glisse[0].text === "change de plan")
  const cmd = t("item/completed", { item: { type: "commandExecution", id: "c1", command: "ls", aggregatedOutput: "a\nb", exitCode: 0, status: "completed" } })
  check(
    "une commande devient `command_execution`, avec sa sortie",
    cmd[0].type === "item.completed" && cmd[0].item.type === "command_execution" && cmd[0].item.output === "a\nb" && cmd[0].item.command === "ls"
  )
  check("un message de l'agent devient `agent_message`", t("item/completed", { item: { type: "agentMessage", id: "a", text: "fini" } })[0].item.text === "fini")
  t("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 } } })
  t("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 1500, cachedInputTokens: 1200, outputTokens: 70 } } })
  const fin = t("turn/completed", { turn: { status: "completed" } })
  check(
    "**la dépense du tour : la fenêtre sur la dernière requête, la sortie additionnée**",
    fin[0].type === "turn.completed" && fin[0].usage.input_tokens === 1500 && fin[0].usage.cached_input_tokens === 1200 && fin[0].usage.output_tokens === 120,
    JSON.stringify(fin)
  )
  check("un tour échoué le dit", t("turn/completed", { turn: { status: "failed", error: { message: "quota" } } })[0].message === "quota")
  check("une erreur que le serveur retente n'en est pas encore une", t("error", { error: { message: "x" }, willRetry: true }).length === 0)
  const p = m.codexServerPolicy
  check(
    "**la permission du panneau, dans les mots du serveur, sans jamais demander**",
    p("read").sandbox === "read-only" && p("project").sandbox === "workspace-write" && p("yolo").sandbox === "danger-full-access" && p("project").approvalPolicy === "never"
  )
  check(
    "les réglages `-c` d'exec passent au serveur, et rien d'autre",
    JSON.stringify(m.configPairs(["exec", "--json", "-c", "a=1", "--model", "x", "-c", "b=2", "-"])) === JSON.stringify(["-c", "a=1", "-c", "b=2"])
  )
  check("les images partent par leur chemin", m.codexInput("t", ["/i.png"])[1].type === "localImage")
}

// ---- Codex : le dialogue JSON-RPC ------------------------------------------
{
  const ecrit = []
  const emis = []
  let fini = false
  const tour = new m.CodexServerTurn((l) => ecrit.push(JSON.parse(l)), (e) => emis.push(e), () => (fini = true))
  const repond = (method, result) => {
    const req = ecrit.find((r) => r.method === method && !r.repondu)
    req.repondu = true
    tour.onLine(JSON.stringify({ id: req.id, result }))
  }
  check("**avant que le tour existe, rien ne se glisse**", (await tour.steer("trop tôt")) === false)
  const demarrage = tour.start({ cwd: "/p", model: "m", sandbox: "workspace-write", approvalPolicy: "never", resume: null, input: m.codexInput("q") })
  await new Promise((r) => setImmediate(r))
  repond("initialize", {})
  await new Promise((r) => setImmediate(r))
  check("`initialized` suit `initialize`", ecrit.some((r) => r.method === "initialized"))
  repond("thread/start", { thread: { id: "fil-1" } })
  await new Promise((r) => setImmediate(r))
  const ouverture = ecrit.find((r) => r.method === "thread/start")
  check("le fil s'ouvre dans le projet, avec le bac à sable et le modèle", ouverture.params.cwd === "/p" && ouverture.params.sandbox === "workspace-write" && ouverture.params.model === "m")
  check("**l'identifiant du fil est appris comme chez exec**", emis.some((e) => e.type === "thread.started" && e.thread_id === "fil-1"))
  repond("turn/start", { turn: { id: "tour-1" } })
  await demarrage
  const glisse = tour.steer("change de plan")
  await new Promise((r) => setImmediate(r))
  const steer = ecrit.find((r) => r.method === "turn/steer")
  check("**turn/steer vise le fil et le tour en cours**", steer?.params.threadId === "fil-1" && steer?.params.expectedTurnId === "tour-1" && steer?.params.input[0].text === "change de plan")
  repond("turn/steer", { turnId: "tour-1" })
  check("et dit oui quand le serveur l'accepte", (await glisse) === true)
  const refus = tour.steer("refusé")
  await new Promise((r) => setImmediate(r))
  const second = ecrit.filter((r) => r.method === "turn/steer")[1]
  tour.onLine(JSON.stringify({ id: second.id, error: { message: "no active turn" } }))
  check("**et non quand il refuse — le message retourne alors dans la file**", (await refus) === false)
  tour.onLine(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }))
  check("une demande d'approbation reçoit un refus, pas un silence", ecrit.some((r) => r.id === 99 && r.error))
  tour.onLine(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }))
  check("le tour fini ferme le serveur", fini === true)
  check("après la fin, rien ne se glisse plus", (await tour.steer("trop tard")) === false)

  const reprise = []
  const t2 = new m.CodexServerTurn((l) => reprise.push(JSON.parse(l)), () => {}, () => {})
  void t2.start({ cwd: "/p", model: null, sandbox: "read-only", approvalPolicy: "never", resume: "fil-ancien", input: [] })
  await new Promise((r) => setImmediate(r))
  t2.onLine(JSON.stringify({ id: reprise[0].id, result: {} }))
  await new Promise((r) => setImmediate(r))
  check("**une conversation reprise rouvre son fil**", reprise.some((r) => r.method === "thread/resume" && r.params.threadId === "fil-ancien"))
  t2.closed()
}

// ---- La fenêtre : quand glisser ---------------------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const regle = panel.slice(panel.indexOf("export function canSteer"), panel.indexOf("export function canSteer") + 900)
  check(
    "**seulement Claude et Codex, pendant un tour**",
    /thread\.turnId === null\) return false/.test(regle) && /thread\.kind !== "claude" && thread\.kind !== "codex"/.test(regle)
  )
  check("pas les images, pas une commande `/`, pas devant un message qui attendait", /images\.length > 0/.test(regle) && /startsWith\("\/"\)/.test(regle) && /queued\.every\(\(q\) => q\.steering === true\)/.test(regle))
  check("**refusé, il redevient un message en attente**", /if \(ok\) return\s*mapThread\(threadId, \(t\) => \(\{ \.\.\.t, queued: t\.queued\.map\(\(q\) => \(q\.id === qid \? \{ \.\.\.q, steering: false \}/.test(panel))
  check("**pris, il quitte la file et prend sa place dans le fil**", /onSteered\(\(\{ id, text \}\) => steered\(id, text\)\)/.test(panel) && /turnToMessage\.set\(turnId, \{ threadId: bound\.threadId, messageId: suite\.id \}\)/.test(panel))
}

// ---- De bout en bout, avec de faux harnais -----------------------------------
//
// Des scripts `#!` : Windows ne les lance pas. La partie ci-dessus suffit à y
// vérifier la logique ; celle-ci tourne sur macOS et Linux.
if (process.platform === "win32") {
  console.log("  skip  bout en bout (faux harnais en `#!`, non lançables sous Windows)")
} else {
  const bin = mkdtempSync(path.join(os.tmpdir(), "zyvro-steer-"))
  const projet = mkdtempSync(path.join(os.tmpdir(), "zyvro-steer-projet-"))
  // Un faux claude : la forme relevée sur le vrai, mode par mode.
  writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
const mode = process.env.FAUX_MODE
if (process.env.FAUX_ARGS) require("node:fs").writeFileSync(process.env.FAUX_ARGS, JSON.stringify(process.argv.slice(2)))
let lignes = [], fin = false, tours = 0
const texte = (l) => l.message.content.map((c) => c.text).join("")
process.stdin.setEncoding("utf8")
let buf = ""
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lignes.push(JSON.parse(l)) } })
process.stdin.on("end", () => { fin = true })
const attendre = (ms) => new Promise((r) => setTimeout(r, ms))
;(async () => {
  while (lignes.length === 0) await attendre(10)
  const q = lignes.shift()
  out({ type: "system", subtype: "init", session_id: "s-1" })
  out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: texte(q) }] } })
  if (mode === "stubborn" || mode === "linger") {
    process.on("SIGTERM", () => {})
    if (mode === "stubborn") {
      const helper = require("node:child_process").spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" })
      require("node:fs").writeFileSync(process.env.FAUX_CHILD, String(helper.pid))
      await attendre(150)
      out({ type: "assistant", message: { content: [{ type: "text", text: "READY" }] } })
    } else {
      out({ type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } })
      out({ type: "result", subtype: "success", result: "DONE", queued_turn_count: 0, usage: {} })
    }
    setInterval(() => {}, 1000)
    return
  }
  if (mode === "late") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "réponse finale" }] } })
    await attendre(500)
    // Mesuré : 0 même quand un message attend — le compteur n'est pas fiable.
    out({ type: "result", subtype: "success", result: "réponse finale", queued_turn_count: 0, usage: {} })
    while (lignes.length > 0) {
      const s = lignes.shift()
      out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: texte(s) }] } })
      out({ type: "assistant", message: { content: [{ type: "text", text: "SECOND:" + texte(s) }] } })
      out({ type: "result", subtype: "success", result: "x", queued_turn_count: lignes.length, usage: {} })
    }
  } else {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep" } }] } })
    await attendre(500)
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "UN" }] } })
    let dit = "sans changement"
    while (lignes.length > 0) {
      const s = lignes.shift()
      out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: texte(s) }] } })
      dit = "ACK:" + texte(s)
    }
    out({ type: "assistant", message: { content: [{ type: "text", text: dit }] } })
    out({ type: "result", subtype: "success", result: dit, queued_turn_count: 0, usage: {} })
  }
  const t0 = Date.now()
  while (!fin && Date.now() - t0 < 4000) await attendre(20)
  process.exit(fin ? 0 : 3)
})()
`
  )
  // Un faux codex : `app-server --help`, puis le dialogue JSON-RPC.
  writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}
const fs = require("node:fs")
if (process.argv.includes("--help")) { console.log("Commands: generate-json-schema"); process.exit(0) }
fs.writeFileSync(process.env.FAUX_ARGS, JSON.stringify(process.argv.slice(2)))
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
let glisse = null
process.stdin.setEncoding("utf8")
let buf = ""
process.stdin.on("end", () => process.exit(0))
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) recu(JSON.parse(l)) } })
function recu(r) {
  if (r.method === "initialize") out({ id: r.id, result: {} })
  if (r.method === "thread/start") { fs.writeFileSync(process.env.FAUX_THREAD, JSON.stringify(r.params)); out({ id: r.id, result: { thread: { id: "fil-x" } } }) }
  if (r.method === "turn/start") {
    out({ id: r.id, result: { turn: { id: "tour-x" } } })
    out({ method: "turn/started", params: { turn: { id: "tour-x" } } })
    out({ method: "item/completed", params: { item: { type: "userMessage", content: r.params.input } } })
    out({ method: "item/completed", params: { item: { type: "agentMessage", id: "a0", text: "Je lance la commande." } } })
    out({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "sleep 1" } } })
    setTimeout(() => {
      out({ method: "item/completed", params: { item: { type: "commandExecution", id: "c1", command: "sleep 1", aggregatedOutput: "UN", exitCode: 0, status: "completed" } } })
      if (glisse) out({ method: "item/completed", params: { item: { type: "userMessage", content: [{ type: "text", text: glisse }] } } })
      out({ method: "item/completed", params: { item: { type: "agentMessage", id: "a1", text: glisse ? "ACK:" + glisse : "sans changement" } } })
      out({ method: "thread/tokenUsage/updated", params: { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } } } })
      out({ method: "turn/completed", params: { turn: { id: "tour-x", status: "completed" } } })
    }, 500)
  }
  if (r.method === "turn/steer") { glisse = r.params.input[0].text; out({ id: r.id, result: { turnId: "tour-x" } }) }
}
`
  )
  chmodSync(path.join(bin, "claude"), 0o755)
  chmodSync(path.join(bin, "codex"), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  process.env.FAUX_ARGS = path.join(bin, "args.json")
  process.env.FAUX_THREAD = path.join(bin, "thread.json")

  const tourDe = async (kind, mode, steerAt, texte = "change de plan") => {
    process.env.FAUX_MODE = mode
    const events = []
    const target = { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, ...payload }) }
    const runner = new m.AgentRunner()
    const id = runner.send(target, kind, "fais deux choses", { projectDir: projet, workflows: [] }, `conv-${kind}-${mode}`)
    await new Promise((r) => setTimeout(r, steerAt))
    const accepte = await runner.steer(id, texte)
    const t0 = Date.now()
    while (!events.some((e) => e.channel === "agent:done" || e.channel === "agent:error") && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20))
    return { accepte, events, texte: events.filter((e) => e.channel === "agent:text").map((e) => e.text).join("") }
  }

  {
    const r = await tourDe("claude", "tool", 150)
    const ordre = r.events.map((e) => e.channel)
    check("**Claude : un message glissé pendant un outil est accepté**", r.accepte === true)
    check(
      "**il est pris avant la réponse, qui en tient compte**",
      ordre.indexOf("agent:steered") >= 0 && ordre.indexOf("agent:steered") < ordre.lastIndexOf("agent:text") && r.texte.includes("ACK:change de plan"),
      ordre.join(",")
    )
    check("un seul accusé, et pas pour la question du tour", r.events.filter((e) => e.channel === "agent:steered").length === 1)
    check("**puis l'entrée se ferme et le tour se termine normalement**", ordre.includes("agent:done") && !ordre.includes("agent:error"), ordre.join(","))
  }
  {
    const r = await tourDe("claude", "late", 150)
    const ordre = r.events.map((e) => e.channel)
    check(
      "**Claude, sans point d'arrêt : il devient un second tour du même processus, et rien n'est perdu**",
      r.accepte === true && r.texte.includes("SECOND:change de plan") && ordre.includes("agent:steered") && ordre.includes("agent:done"),
      ordre.join(",")
    )
  }
  {
    const r = await tourDe("claude", "tool", 2500)
    check("**Claude, tour déjà fini : refusé, le message reste dans la file**", r.accepte === false)
  }
  {
    const r = await tourDe("codex", "tool", 150)
    const ordre = r.events.map((e) => e.channel)
    check("**Codex : turn/steer accepté pendant une commande**", r.accepte === true)
    check(
      "**l'accusé arrive, la réponse en tient compte, le tour se termine**",
      ordre.includes("agent:steered") && r.texte.includes("ACK:change de plan") && ordre.includes("agent:done") && !ordre.includes("agent:error"),
      ordre.join(",")
    )
    const apres = r.events.slice(r.events.findIndex((e) => e.channel === "agent:steered")).find((e) => e.channel === "agent:text")
    check("la réponse d'après commence sans ligne vide", apres && !apres.text.startsWith("\n"), JSON.stringify(apres?.text))
    check("la session de codex est apprise", r.events.some((e) => e.channel === "agent:session" && e.sessionId === "fil-x"))
    check("la dépense du tour arrive", r.events.some((e) => e.channel === "agent:usage" && e.output === 5))
    const lance = JSON.parse(readFileSync(process.env.FAUX_ARGS, "utf8"))
    const fil = JSON.parse(readFileSync(process.env.FAUX_THREAD, "utf8"))
    check("**codex tourne en `app-server`, pas en `exec`**", lance[0] === "app-server" && !lance.includes("exec"), JSON.stringify(lance))
    check("dans le projet, sans jamais demander", fil.cwd === projet && fil.approvalPolicy === "never" && fil.sandbox === "workspace-write")
  }
  {
    const r = await tourDe("codex", "tool", 2000)
    check("**Codex, tour déjà fini : refusé**", r.accepte === false)
  }
  // A CLI can ignore SIGTERM, and MCP/hooks can keep it alive after result.
  // Exercise the real runner with actual processes, without any model account.
  for (const mode of ["stubborn", "linger"]) {
    process.env.FAUX_MODE = mode
    process.env.FAUX_CHILD = path.join(bin, "child.pid")
    const events = []
    const runner = new m.AgentRunner()
    const target = { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, ...payload }) }
    const id = runner.send(target, "claude", "test", { projectDir: projet, workflows: [], daemonOrigin: "http://127.0.0.1:1", daemonToken: "test" }, `conv-${mode}`)
    const child = runner.turns.get(id).child
    let helper = null
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    try {
      const until = Date.now() + 3000
      while (!events.some((e) => e.channel === "agent:text") && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
      const args = JSON.parse(readFileSync(process.env.FAUX_ARGS, "utf8"))
      check("Zyvro MCP config supplements user integrations", args.includes("--mcp-config") && !args.includes("--strict-mcp-config"))
      if (mode === "stubborn") {
        helper = Number(readFileSync(process.env.FAUX_CHILD, "utf8"))
        runner.cancel(id)
        runner.cancel(id)
      }
      await new Promise((r) => setTimeout(r, 150))
      check(`${mode}: the UI finishes without waiting for process exit`, events.filter((e) => e.channel === "agent:done").length === 1)
      check(`${mode}: no late steering into a finished turn`, (await runner.steer(id, "too late")) === false)
      check(`${mode}: no phantom running turn`, runner.running().length === 0)
      await new Promise((r) => setTimeout(r, mode === "stubborn" ? 2200 : 5500))
      check(`${mode}: the CLI is reaped even when it ignores SIGTERM`, !alive(child.pid))
      if (helper) check("Stop also reaps the CLI's child process", !alive(helper))
      check(`${mode}: completion is emitted exactly once, without a spurious error`, events.filter((e) => e.channel === "agent:done").length === 1 && !events.some((e) => e.channel === "agent:error"))
    } finally {
      for (const pid of [helper, child.pid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL")
      runner.cancelAll()
    }
  }
  rmSync(bin, { recursive: true, force: true })
  rmSync(projet, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nUn message écrit pendant que l'agent travaille lui parvient, ou attend son tour — jamais perdu." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
