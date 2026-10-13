// Les tâches de fond de Claude survivent à la fin du tour.
//
// Rapport bug_e073d4b2bdc5053f : l'agent lance un téléchargement en fond
// (Bash `run_in_background`), dit « j'attends la fin », et finit son tour.
// Studio fermait alors l'entrée de Claude puis tuait son groupe de processus :
// le téléchargement mourait avec, et la reprise promise n'arrivait jamais.
//
// Ce qui a été MESURÉ sur claude 2.1.296 (`-p --input-format stream-json`),
// et que le faux claude de ce script reproduit : la tâche annoncée par
// `system/background_tasks_changed` (la liste entière) et `task_started`, le
// résultat du tour, puis, la tâche finie, `task_notification`, la liste vide,
// un nouvel `init` et une réponse — Claude reprend seul, si son entrée est
// encore ouverte. Fermée, le processus sort et la tâche est tuée
// (`task_updated` : killed).
//
// Ce qui casse en silence ici :
//
// 1. **Le processus tué au résultat** alors qu'une tâche tourne.
// 2. **La reprise de Claude invisible** : un tour sans bulle, qui dépense et
//    que personne ne voit.
// 3. **Un second processus** pour la question suivante, qui laisserait le
//    premier — et sa tâche — sans personne.
// 4. **Pas d'arrêt possible** d'un serveur lancé en fond.
//
//     node scripts/check-background-tasks.mjs
import { build } from "esbuild"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-background-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(os.tmpdir())}, isPackaged: false } }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { AgentRunner, backgroundTasksIn, backgroundEventIn, backgroundWakeText, PARKED_IDLE } from "${from("src/main/agent")}"\n` +
    `export { isBackgroundWake } from "${from("src/renderer/state/background")}"\n`
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

// ---- La lecture des événements -------------------------------------------
{
  const listed = m.backgroundTasksIn({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", description: "Download assets" }, { nope: 1 }] })
  check("**la liste des tâches de fond se lit telle que Claude la publie**", JSON.stringify(listed) === JSON.stringify([{ id: "b1", description: "Download assets", toolUseId: null, startedAt: 0, outputFile: null }]))
  check("une liste vide reste une liste (tout est fini)", JSON.stringify(m.backgroundTasksIn({ type: "system", subtype: "background_tasks_changed", tasks: [] })) === "[]")
  check("une autre ligne n'en parle pas", m.backgroundTasksIn({ type: "system", subtype: "init" }) === null)
  check("la reprise porte le résumé de la tâche", m.backgroundWakeText("Download assets") === "Background task finished: Download assets")
  check(
    "**la fenêtre reconnaît la reprise que le principal écrit (bulle « Background », pas « You »)**",
    m.isBackgroundWake(m.backgroundWakeText("Download assets")) && m.isBackgroundWake(m.backgroundWakeText("")) && !m.isBackgroundWake("Background task finished") && !m.isBackgroundWake("hello")
  )
  // Le texte relevé sur le vrai claude : le chemin est suivi d'un point.
  const vrai = "Command running in background with ID: b7mwssndy. Output is being written to: /private/tmp/claude-501/x/tasks/b7mwssndy.output. You will be notified when it completes."
  const out = m.backgroundEventIn({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: vrai }] } })
  check("**le journal d'une tâche se lit dans le résultat de l'outil, sans le point final**", out?.kind === "output" && out.id === "b7mwssndy" && out.file === "/private/tmp/claude-501/x/tasks/b7mwssndy.output", JSON.stringify(out))
  const parti = m.backgroundEventIn({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "toolu_1" })
  check("le départ dit quel appel d'outil l'a lancée", parti?.kind === "started" && parti.toolUseId === "toolu_1")
  const fini = m.backgroundEventIn({ type: "system", subtype: "task_notification", task_id: "b1", status: "failed", summary: "x", output_file: "/t/b1.output" })
  check("la fin dit comment", fini?.kind === "ended" && fini.status === "failed" && fini.file === "/t/b1.output")
}

// ---- De bout en bout, avec un faux claude ------------------------------------
if (process.platform === "win32") {
  console.log("  skip  bout en bout (faux harnais en `#!`, non lançables sous Windows)")
} else {
  const bin = mkdtempSync(path.join(os.tmpdir(), "zyvro-bg-"))
  const projet = mkdtempSync(path.join(os.tmpdir(), "zyvro-bg-projet-"))
  writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}
const fs = require("node:fs")
fs.appendFileSync(process.env.FAUX_SPAWNS, "spawn\\n")
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
const mode = process.env.FAUX_MODE
let lignes = [], fin = false
const texte = (l) => l.message.content.map((c) => c.text).join("")
process.stdin.setEncoding("utf8")
let buf = ""
process.stdin.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) lignes.push(JSON.parse(l)) } })
process.stdin.on("end", () => { fin = true })
const attendre = (ms) => new Promise((r) => setTimeout(r, ms))
const tache = (liste) => out({ type: "system", subtype: "background_tasks_changed", tasks: liste })
;(async () => {
  while (lignes.length === 0) await attendre(10)
  const q = lignes.shift()
  out({ type: "system", subtype: "init", session_id: "s-bg" })
  out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: texte(q) }] } })
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "download", run_in_background: true } }] } })
  tache([{ task_id: "b1", run_id: "r", task_type: "local_bash", description: "Download assets" }])
  out({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t1", is_backgrounded: true })
  const journal = require("node:path").join(process.env.FAUX_DIR, "b1.output")
  fs.writeFileSync(journal, "part 1/13 ok\\npart 2/13 ok\\n")
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: b1. Output is being written to: " + journal + ". You will be notified when it completes." }] } })
  out({ type: "assistant", message: { content: [{ type: "text", text: "STARTED" }] } })
  out({ type: "result", subtype: "success", result: "STARTED", queued_turn_count: 0, usage: {} })
  if (mode === "finishes") {
    await attendre(600)
    // Mesuré : fermée avant la fin de la tâche, l'entrée fait sortir le
    // processus et la tâche est tuée.
    if (fin) { out({ type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "killed" } }); process.exit(0) }
    out({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "Download assets", output_file: journal })
    tache([])
    out({ type: "system", subtype: "init", session_id: "s-bg" })
    out({ type: "assistant", message: { content: [{ type: "text", text: "FINISHED" }] } })
    out({ type: "result", subtype: "success", result: "FINISHED", queued_turn_count: 0, usage: {} })
  } else if (mode === "adopt") {
    while (lignes.length === 0 && !fin) await attendre(10)
    if (fin) process.exit(0)
    const s = lignes.shift()
    out({ type: "system", subtype: "init", session_id: "s-bg" })
    out({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: texte(s) }] } })
    out({ type: "assistant", message: { content: [{ type: "text", text: "ADOPTED:" + texte(s) }] } })
    out({ type: "result", subtype: "success", result: "x", queued_turn_count: 0, usage: {} })
    await attendre(200)
    out({ type: "system", subtype: "task_notification", task_id: "b1", status: "completed", summary: "Download assets" })
    tache([])
    out({ type: "system", subtype: "init", session_id: "s-bg" })
    out({ type: "assistant", message: { content: [{ type: "text", text: "FINISHED" }] } })
    out({ type: "result", subtype: "success", result: "FINISHED", queued_turn_count: 0, usage: {} })
  } else if (mode === "forever") {
    setInterval(() => {}, 1000)
    return
  } else if (mode === "silent") {
    // La tâche finit, et Claude ne reprend pas : on ne garde pas le processus.
    await attendre(300)
    tache([])
  }
  while (!fin) await attendre(20)
  process.exit(0)
})()
`
  )
  chmodSync(path.join(bin, "claude"), 0o755)
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  process.env.FAUX_SPAWNS = path.join(bin, "spawns.txt")
  process.env.FAUX_DIR = bin
  const spawns = () => (existsSync(process.env.FAUX_SPAWNS) ? readFileSync(process.env.FAUX_SPAWNS, "utf8").trim().split("\n").length : 0)
  const attendre = (ms) => new Promise((r) => setTimeout(r, ms))
  const jusqua = async (cond, ms = 6000) => {
    const t0 = Date.now()
    while (!cond() && Date.now() - t0 < ms) await attendre(20)
    return cond()
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

  const lancer = (mode, conv) => {
    process.env.FAUX_MODE = mode
    rmSync(process.env.FAUX_SPAWNS, { force: true })
    const events = []
    const target = { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, ...payload }) }
    const runner = new m.AgentRunner()
    const id = runner.send(target, "claude", "télécharge les assets", { projectDir: projet, workflows: [] }, conv)
    const pid = runner.turns.get(id).child.pid
    return { runner, events, id, pid, of: (channel) => events.filter((e) => e.channel === channel) }
  }

  {
    const r = lancer("finishes", "conv-finishes")
    try {
      await jusqua(() => r.of("agent:done").length >= 1)
      check("**le tour finit pour la fenêtre : le panneau est libre**", r.of("agent:done")[0]?.id === r.id)
      check("**le processus reste en vie pendant la tâche de fond**", alive(r.pid))
      check("la fenêtre apprend la tâche qui tourne", r.of("agent:background").some((e) => e.tasks.length === 1 && e.tasks[0].description === "Download assets"))
      const vue = r.of("agent:background").at(-1)?.tasks[0]
      check("**avec l'appel d'outil qui l'a lancée (le badge) et son journal (le bandeau)**", vue?.toolUseId === "t1" && vue?.outputFile?.endsWith("b1.output") && vue?.startedAt > 0, JSON.stringify(vue))
      const lu = await r.runner.backgroundOutput("b1")
      check("**la fin du journal se lit pendant que la tâche tourne**", lu?.includes("part 2/13 ok"), JSON.stringify(lu))
      check("un id inconnu ne lit rien", (await r.runner.backgroundOutput("../../etc/passwd")) === null && (await r.runner.backgroundOutput("zz")) === null)
      await jusqua(() => r.of("agent:done").length >= 2)
      const woke = r.of("agent:woke")[0]
      check("**Claude reprend seul, et la fenêtre l'apprend comme un réveil**", woke && woke.conversationId === "conv-finishes" && woke.turnId !== r.id && woke.prompt === "Background task finished: Download assets", JSON.stringify(woke))
      const apres = r.events.filter((e) => e.channel === "agent:text" && e.id === woke?.turnId).map((e) => e.text).join("")
      check("sa réponse va à ce nouveau tour", apres.includes("FINISHED"), apres)
      check("et ce tour se termine aussi", r.of("agent:done").some((e) => e.id === woke?.turnId))
      check("la tâche finie disparaît de la fenêtre", r.of("agent:background").at(-1)?.tasks.length === 0)
      const fin = r.of("agent:background-ended")[0]
      check("**sa fin est annoncée, avec son statut et l'appel qui l'a lancée**", fin?.task.status === "completed" && fin.task.toolUseId === "t1" && fin.conversationId === "conv-finishes", JSON.stringify(fin))
      await jusqua(() => !alive(r.pid), 5000)
      check("**plus rien en fond : le processus se ferme**", !alive(r.pid))
      check("aucune erreur", r.of("agent:error").length === 0, JSON.stringify(r.of("agent:error")))
    } finally {
      if (alive(r.pid)) process.kill(r.pid, "SIGKILL")
      r.runner.cancelAll()
    }
  }

  {
    const r = lancer("adopt", "conv-adopt")
    try {
      await jusqua(() => r.of("agent:done").length >= 1)
      const second = r.runner.send({ isDestroyed: () => false, send: (channel, payload) => r.events.push({ channel, ...payload }) }, "claude", "où en est-on ?", { projectDir: projet, workflows: [] }, "conv-adopt")
      await jusqua(() => r.of("agent:done").some((e) => e.id === second))
      const texte = r.events.filter((e) => e.channel === "agent:text" && e.id === second).map((e) => e.text).join("")
      check("**la question suivante part dans le même processus, pas dans un second**", spawns() === 1 && texte.includes("ADOPTED:où en est-on ?"), `spawns=${spawns()} texte=${texte}`)
      await jusqua(() => r.of("agent:woke").length >= 1)
      check("et la reprise après la tâche arrive quand même", r.of("agent:woke").length === 1)
    } finally {
      if (alive(r.pid)) process.kill(r.pid, "SIGKILL")
      r.runner.cancelAll()
    }
  }

  {
    const r = lancer("forever", "conv-forever")
    try {
      await jusqua(() => r.of("agent:done").length >= 1)
      check("un serveur lancé en fond garde son processus", alive(r.pid))
      check("**Stop arrête la tâche et son processus**", r.runner.stopBackground("conv-forever") === true)
      await jusqua(() => !alive(r.pid), 4000)
      check("le processus est bien mort", !alive(r.pid))
      check("la fenêtre l'apprend", r.of("agent:background").at(-1)?.tasks.length === 0)
      check("**une tâche arrêtée est annoncée « stopped », pas effacée sans un mot**", r.of("agent:background-ended").some((e) => e.task.status === "stopped" && e.task.toolUseId === "t1"))
      check("rien à arrêter ensuite", r.runner.stopBackground("conv-forever") === false)
    } finally {
      if (alive(r.pid)) process.kill(r.pid, "SIGKILL")
      r.runner.cancelAll()
    }
  }

  {
    const avant = m.PARKED_IDLE.ms
    m.PARKED_IDLE.ms = 300
    const r = lancer("silent", "conv-silent")
    try {
      await jusqua(() => r.of("agent:done").length >= 1)
      await jusqua(() => !alive(r.pid), 5000)
      check("**la tâche finie sans reprise de Claude : le processus ne traîne pas**", !alive(r.pid))
      check("sans bulle fantôme ni erreur", r.of("agent:woke").length === 0 && r.of("agent:error").length === 0)
    } finally {
      m.PARKED_IDLE.ms = avant
      if (alive(r.pid)) process.kill(r.pid, "SIGKILL")
      r.runner.cancelAll()
    }
  }

  {
    const r = lancer("forever", "conv-quit")
    try {
      await jusqua(() => r.of("agent:done").length >= 1)
      r.runner.cancelAll()
      await jusqua(() => !alive(r.pid), 4000)
      check("**la fenêtre fermée emporte les tâches de fond**", !alive(r.pid))
    } finally {
      if (alive(r.pid)) process.kill(r.pid, "SIGKILL")
    }
  }

  rmSync(bin, { recursive: true, force: true })
  rmSync(projet, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nUne tâche de fond survit à la fin du tour, l'agent reprend quand elle finit, et on peut l'arrêter." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
