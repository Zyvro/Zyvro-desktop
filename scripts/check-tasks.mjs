// La file de tâches d'un projet, et sa mémoire.
//
// Ce qui casse en silence ici :
//
// 1. **Une tâche qui coupe la conversation en cours.** La règle est « quand
//    l'agent est libre » : une tâche due pendant un tour attend, et la suivante
//    attend la fin de celle-ci. Deux tours à la fois dépensent deux fois, et
//    l'un écrit par-dessus l'autre.
// 2. **Un rendez-vous qui dérive.** « Tous les jours à 9 h » calculé en
//    tranches de 24 h glisse à 10 h au changement d'heure ; une échéance
//    manquée pendant le week-end ne doit partir qu'une fois, pas trois.
// 3. **Une tâche unique relancée au redémarrage.** Écrite « partie » à son
//    départ, pas à son arrivée : fermer l'application en plein tour ne la
//    refait pas tourner demain.
// 4. **Une mémoire qui n'arrive pas.** ZYVRO.md doit être dans le préambule de
//    chaque harnais — claude et codex lisent leurs propres fichiers, pas
//    celui-là.
//
//     node scripts/check-tasks.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-tasks-check")
mkdirSync(dir, { recursive: true })
const src = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(path.join(dir, "electron.js"), "module.exports = { app: { getPath: () => require('os').tmpdir() }, nativeImage: {} }\n")
writeFileSync(
  path.join(dir, "h.ts"),
  [
    `export * as shared from "${src("src/shared/tasks")}"`,
    `export * as memory from "${src("src/shared/memory")}"`,
    `export { readTasks, writeTasks } from "${src("src/main/tasks")}"`,
    `export { readMemory, writeMemory, memoryForAgent } from "${src("src/main/memory")}"`,
    `export { argsFor } from "${src("src/main/agent")}"`,
  ].join("\n")
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT, logLevel: "silent",
})
const req = createRequire(import.meta.url)
const { shared, memory, readTasks, writeTasks, readMemory, writeMemory, memoryForAgent, argsFor } = req(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}
const at = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const task = (over) => ({ id: "a", title: "A", prompt: "do a", at: null, repeat: "none", enabled: true, runs: 0, createdAt: 0, ...over })

console.log("quand une tâche revient")
{
  const { nextAfter } = shared
  const lundi9 = at(2026, 10, 5) // lundi 5 octobre 2026, 9 h
  check("une tâche unique ne revient pas", nextAfter(lundi9, "none", lundi9 + 1) === null)
  check("tous les jours : le lendemain, même heure", nextAfter(lundi9, "daily", lundi9 + 1) === at(2026, 10, 6))
  // Passage à l'heure d'hiver en Europe le 25 octobre 2026 : 9 h reste 9 h.
  const avant = at(2026, 10, 24)
  const apres = new Date(nextAfter(avant, "daily", avant + 1))
  check("**tous les jours à 9 h reste 9 h au changement d'heure**", apres.getHours() === 9 && apres.getDate() === 25, apres.toString())
  const vendredi = at(2026, 10, 9)
  check("jours ouvrés : de vendredi à lundi", nextAfter(vendredi, "weekdays", vendredi + 1) === at(2026, 10, 12))
  check("chaque semaine : sept jours plus tard", nextAfter(lundi9, "weekly", lundi9 + 1) === at(2026, 10, 12))
  // L'application était fermée tout le week-end : une seule fois, puis la prochaine à venir.
  const rattrape = nextAfter(at(2026, 10, 2), "daily", at(2026, 10, 5, 14))
  check("**une échéance manquée saute à la prochaine à venir, sans rattraper chaque jour**", rattrape === at(2026, 10, 6), new Date(rattrape).toString())
  const h = at(2026, 10, 5, 9, 30)
  check("toutes les heures : à la demie suivante", nextAfter(h, "hourly", at(2026, 10, 5, 12, 40)) === at(2026, 10, 5, 13, 30))
  check("un rendez-vous encore à venir ne bouge pas", nextAfter(h, "hourly", h - 1) === h)
}

console.log("laquelle part")
{
  const { dueTask, started } = shared
  const now = at(2026, 10, 5, 10)
  const file = {
    paused: false,
    tasks: [
      task({ id: "plus-tard", at: at(2026, 10, 5, 11) }),
      task({ id: "due-1", at: at(2026, 10, 5, 8) }),
      task({ id: "libre", at: null }),
      task({ id: "eteinte", at: null, enabled: false }),
    ],
  }
  check("la première due dans l'ordre de la liste", dueTask(file, now)?.id === "due-1")
  check("une tâche éteinte ne part pas", dueTask({ paused: false, tasks: [file.tasks[3]] }, now) === null)
  check("rien en pause", dueTask({ ...file, paused: true }, now) === null)
  const pressee = { ...file, tasks: [...file.tasks, task({ id: "maintenant", at: at(2026, 10, 6), runNow: true, enabled: false })] }
  check("**« Run now » passe devant, même éteinte, même à l'heure non venue**", dueTask(pressee, now)?.id === "maintenant")

  const unique = started(task({ id: "u", at: at(2026, 10, 5, 8) }), now)
  check("**une tâche unique s'éteint en partant (pas de relance au redémarrage)**", unique.enabled === false && unique.lastRunAt === now && unique.runs === 1)
  const chaqueJour = started(task({ at: at(2026, 10, 5, 9), repeat: "daily" }), now)
  check("une tâche récurrente a déjà son prochain rendez-vous", chaqueJour.enabled && chaqueJour.at === at(2026, 10, 6, 9))
  const avance = started(task({ at: at(2026, 10, 5, 11), repeat: "daily", runNow: true }), now)
  check("**« Run now » avant l'heure garde le rendez-vous du jour**", avance.at === at(2026, 10, 5, 11) && !avance.runNow)
}

console.log("le fichier tel qu'il peut être")
{
  const { parseTasks } = shared
  check("rien du tout : une file vide", parseTasks(null).tasks.length === 0 && parseTasks("x").paused === false)
  const lu = parseTasks({
    paused: true,
    tasks: [
      { id: "ok", prompt: "relis les PR", repeat: "daily", at: 5 },
      { id: "ok", prompt: "doublon" },
      { id: "vide", prompt: "   " },
      { prompt: "sans id" },
      { id: "bizarre", prompt: "x", repeat: "monthly", at: "demain", enabled: "oui" },
      42,
    ],
  })
  check("ce qui ne ressemble pas à une tâche est laissé de côté, le reste est gardé", lu.paused && lu.tasks.map((t) => t.id).join() === "ok,bizarre", JSON.stringify(lu.tasks.map((t) => t.id)))
  check("un titre absent vient de la question", lu.tasks[0].title === "relis les PR")
  check("une récurrence inconnue devient « une fois », une date illisible « dès que libre »", lu.tasks[1].repeat === "none" && lu.tasks[1].at === null && lu.tasks[1].enabled === true)

  const projet = mkdtempSync(path.join(os.tmpdir(), "zyvro-tasks-"))
  check("un projet sans file : vide, sans erreur", (await readTasks(projet)).tasks.length === 0)
  await writeTasks(projet, { paused: false, tasks: [task({ id: "x" }), { id: "mauvaise" }] })
  const relu = await readTasks(projet)
  check("écrite dans .zyvro/tasks.json et relue telle quelle, sans ce qui n'était pas une tâche", relu.tasks.length === 1 && relu.tasks[0].id === "x" && JSON.parse(readFileSync(path.join(projet, ".zyvro/tasks.json"), "utf8")).tasks.length === 1)
}

console.log("la mémoire du projet")
{
  const { memoryState, memoryPreamble, memoryPrompt, MEMORY_INJECT_LIMIT } = memory
  const now = at(2026, 10, 5)
  const DAY = 86_400_000
  check("pas de fichier : vide", memoryState({ text: null, updatedAt: null, commitsSince: null, now }) === "empty")
  check("un fichier blanc : vide aussi", memoryState({ text: "  \n", updatedAt: now, commitsSince: 0, now }) === "empty")
  check("écrite hier, deux commits depuis : à jour", memoryState({ text: "# x", updatedAt: now - DAY, commitsSince: 2, now }) === "fresh")
  check("**vingt commits depuis : vieillie**", memoryState({ text: "# x", updatedAt: now - DAY, commitsSince: 20, now }) === "stale")
  check("deux semaines et un commit : vieillie", memoryState({ text: "# x", updatedAt: now - 15 * DAY, commitsSince: 1, now }) === "stale")
  check("**un dépôt qui n'a pas bougé ne fait pas vieillir sa mémoire**", memoryState({ text: "# x", updatedAt: now - 90 * DAY, commitsSince: 0, now }) === "fresh")
  check("hors git, un mois", memoryState({ text: "# x", updatedAt: now - 31 * DAY, commitsSince: null, now }) === "stale")
  check("pas de mémoire, pas de passage dans le préambule", memoryPreamble(null) === "" && memoryPreamble("  ") === "")
  const long = memoryPreamble("x".repeat(MEMORY_INJECT_LIMIT + 500))
  check("une mémoire trop longue est coupée, et le dit", long.length < MEMORY_INJECT_LIMIT + 600 && long.includes("truncated"))
  check("l'agent d'entretien n'écrit que ZYVRO.md", memoryPrompt(true).includes("Write only ZYVRO.md") && memoryPrompt(false).startsWith("Create ZYVRO.md"))

  // Le vrai fichier, dans un vrai dépôt : l'état se mesure aux commits.
  const repo = mkdtempSync(path.join(os.tmpdir(), "zyvro-memory-"))
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  git("init", "-q")
  writeFileSync(path.join(repo, "a.txt"), "a")
  git("add", "."); git("commit", "-qm", "a")
  check("un dépôt sans ZYVRO.md : vide", (await readMemory(repo)).state === "empty")
  await writeMemory(repo, "# Mémoire\n\nnpm test")
  const ecrite = await readMemory(repo)
  check("écrite depuis le panneau : à jour, zéro commit depuis", ecrite.state === "fresh" && ecrite.commitsSince === 0 && ecrite.text.includes("npm test"), JSON.stringify(ecrite))
  // On la vieillit d'un jour, puis vingt commits ailleurs dans le dépôt.
  const hier = (Date.now() - 86_400_000) / 1000
  utimesSync(path.join(repo, "ZYVRO.md"), hier, hier)
  for (let i = 0; i < 20; i++) {
    writeFileSync(path.join(repo, "a.txt"), String(i))
    git("commit", "-qam", `c${i}`)
  }
  const vieille = await readMemory(repo)
  // 21 : les vingt, plus le tout premier — fait après « hier ».
  check("**vingt commits après elle : vieillie, et le compte est juste**", vieille.state === "stale" && vieille.commitsSince === 21, JSON.stringify({ state: vieille.state, n: vieille.commitsSince }))

  // Ce que reçoit l'agent : la mémoire dans le préambule, quel que soit le harnais.
  const texte = await memoryForAgent(repo)
  const ctx = { projectDir: repo, workflows: [], memory: texte }
  const claude = argsFor("claude", ctx, null)
  const systeme = claude[claude.indexOf("--append-system-prompt") + 1] ?? ""
  check("**claude reçoit ZYVRO.md dans son prompt système**", systeme.includes("<project-memory>") && systeme.includes("npm test"))
  const qwen = argsFor("qwen", ctx, null)
  check("qwen aussi", (qwen[qwen.indexOf("--append-system-prompt") + 1] ?? "").includes("npm test"))
  const sans = argsFor("claude", { projectDir: repo, workflows: [] }, null)
  check("sans mémoire, rien d'ajouté", !sans[sans.indexOf("--append-system-prompt") + 1].includes("project-memory"))
  // codex et MiMo n'ont pas de prompt système : le préambule ouvre la question
  // (agent.ts). Le même `preamble`, donc la même mémoire — vérifié sur la source.
  const agent = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  check("codex et MiMo reçoivent le même préambule en tête de question", /envelope !== "claude" \? `\$\{preamble\(ctx\)\}/.test(agent))
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  // Relue à chaque tour tant que le plugin « Project memory » est allumé.
  check("chaque tour relit ZYVRO.md", /const memory = pluginOn\(agentSettings, "memory"\) \? await memoryForAgent\(root\) : null/.test(ipc) && /\n\s+memory,\n/.test(ipc))
}

// ---- l'horloge de la file, avec un faux agent ----------------------------
console.log("l'horloge : une à la fois, quand l'agent est libre")
{
  const saved = []
  let disque = { paused: false, tasks: [] }
  globalThis.window = {
    zyvro: {
      project: {
        tasks: async () => disque,
        saveTasks: async (_p, file) => { saved.push(file); disque = file; return file },
        onTasksChanged: () => () => {},
      },
    },
  }
  writeFileSync(
    path.join(dir, "r.ts"),
    `export * from "${src("src/renderer/state/tasks")}"\nexport { useWorkspace } from "${src("src/renderer/state/workspace")}"\n`
  )
  await build({
    entryPoints: [path.join(dir, "r.ts")],
    outfile: path.join(dir, "r.cjs"),
    bundle: true, format: "cjs", platform: "node",
    alias: { "~": path.join(ROOT, "src/renderer"), "@": path.join(ROOT, "../Zyvro-frontend/src") },
    absWorkingDir: ROOT, logLevel: "silent",
  })
  const t = req(path.join(dir, "r.cjs"))
  const tick = () => new Promise((r) => { t.tickTasks(); setTimeout(r, 5) })

  // Un agent qu'on pilote à la main : occupé ou libre, et ce qu'il a lancé.
  // `affichee` : la session à l'écran. Comme AgentPanel, le faux agent
  // n'ouvre jamais d'onglet : sans conversation à reprendre, il part dans
  // celle qu'on regarde.
  const fils = new Map([["S1", "done"]])
  let affichee = "S1"
  let occupeAilleurs = false
  const lances = []
  t.setTaskRunner({
    idle: () => !occupeAilleurs && [...fils.values()].every((f) => f !== "running"),
    status: (id) => fils.get(id),
    session: () => affichee,
    run: (task, reprise) => {
      const id = reprise ?? affichee
      fils.set(id, "running")
      lances.push({ task: task.id, fil: id })
      return id
    },
  })
  t.useWorkspace.setState({ project: { project: "/p", name: "p" } })
  await new Promise((r) => setTimeout(r, 10))
  check("la file du projet ouvert est relue", t.useTasks.getState().loaded && t.useTasks.getState().project === "/p")

  occupeAilleurs = true
  t.addTask({ title: "", prompt: "première", at: null, repeat: "none" })
  t.addTask({ title: "Deux", prompt: "seconde", at: null, repeat: "none" })
  await tick()
  check("**une conversation tourne : rien ne part**", lances.length === 0)
  occupeAilleurs = false
  await tick()
  check("l'agent libre : la première part, et seulement elle", lances.length === 1 && lances[0].task === t.useTasks.getState().file.tasks[0].id)
  check("**elle part dans la session où on l'a créée, pas dans un onglet neuf**", lances[0].fil === "S1" && t.useTasks.getState().file.tasks[0].thread === "S1", JSON.stringify(lances[0]))
  check("elle est écrite « partie » tout de suite", t.useTasks.getState().file.tasks[0].enabled === false && disque.tasks[0].runs === 1)
  await tick(); await tick()
  check("**la seconde attend la fin de la première**", lances.length === 1)
  fils.set(lances[0].fil, "done")
  t.taskTurnEnded(lances[0].fil, "done")
  await tick()
  check("la première finie : la seconde part", lances.length === 2 && lances[1].task === t.useTasks.getState().file.tasks[1].id)
  check("la première a son résultat", t.useTasks.getState().file.tasks[0].lastStatus === "done")
  // Un tour qui s'arrête sans que personne ne le dise (onglet fermé) ne bloque pas la file.
  fils.delete(lances[1].fil)
  await tick()
  check("**une conversation disparue en plein tour libère la file (arrêtée)**", t.useTasks.getState().running === null && t.useTasks.getState().file.tasks[1].lastStatus === "stopped")

  // Récurrente : reprend sa conversation, et ne repart qu'au prochain rendez-vous.
  fils.set("S2", "done")
  affichee = "S2"
  t.addTask({ title: "Matin", prompt: "relis", at: Date.now() - 1000, repeat: "daily" })
  await tick()
  const matin = t.useTasks.getState().file.tasks[2]
  check("une récurrente échue part, et vise demain", lances.length === 3 && matin.at > Date.now() + 23 * 3_600_000)
  fils.set(lances[2].fil, "done"); t.taskTurnEnded(lances[2].fil, "done")
  t.runTaskNow(matin.id)
  await tick()
  check("**« Run now » la relance dans sa propre conversation**", lances.length === 4 && lances[3].fil === lances[2].fil)
  fils.set(lances[3].fil, "failed")
  await tick()
  check("un tour en erreur est noté comme tel", t.useTasks.getState().file.tasks[2].lastStatus === "failed")
  t.setQueuePaused(true)
  t.runTaskNow(matin.id)
  await tick()
  check("en pause, même « Run now » attend", lances.length === 4)
  check("tout est écrit sur le disque", disque.paused === true && disque.tasks.length === 3)
  check("la récurrente a été créée et lancée dans S2, la session alors affichée", matin.thread === "S2" && lances[2].fil === "S2")

  // Sa session fermée entre-temps : elle part dans celle qu'on regarde.
  // (La reprise lance d'abord le « Run now » resté en attente pendant la pause.)
  t.setQueuePaused(false)
  await tick()
  for (const l of lances) fils.set(l.fil, "done")
  const enCours = t.useTasks.getState().running
  if (enCours) t.taskTurnEnded(enCours.threadId, "done")
  await tick()
  fils.set("S3", "done")
  affichee = "S3"
  t.addTask({ title: "Plus tard", prompt: "après", at: null, repeat: "none" })
  // On ferme S3 avant qu'elle parte, et on passe sur S4.
  occupeAilleurs = true
  await tick()
  fils.delete("S3")
  fils.set("S4", "done")
  affichee = "S4"
  occupeAilleurs = false
  const avant = lances.length
  await tick()
  check("**sa session fermée, elle part dans la session affichée, toujours sans nouvel onglet**", lances.length === avant + 1 && lances.at(-1).fil === "S4", JSON.stringify(lances.at(-1)))
}

console.log(failures === 0 ? "\nLa file attend l'agent, une tâche à la fois, et la mémoire arrive à chaque harnais." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
