// La mise à jour Windows, pour de vrai : le script PowerShell de updater.ts,
// lancé par le vrai startUpdateHelper avec les mêmes arguments que l'application.
//
// check-update-helper.mjs remplace PowerShell par un faux : il vérifie la
// poignée de main, pas le script. Signalé sur Windows après alpha.88 : « The
// update did not work — Could not start the updater: helper exited (0) », et
// au redémarrage l'application redemande la mise à jour. Le script ne s'était
// jamais exécuté sous un vrai PowerShell avant d'être livré.
//
// Ici : une fausse installation (resources/app.asar = "old"), un paquet déplié
// (resources/app.asar = "new"), un faux processus d'application. On attend
// que l'auxiliaire se dise prêt, on « quitte » (commit + fin du processus), et
// l'installation doit porter la nouvelle version.
//
//     node --experimental-strip-types scripts/check-update-windows.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

if (process.platform !== "win32") {
  console.log("  (pas Windows : rien à vérifier)")
  process.exit(0)
}

const ROOT = path.resolve(import.meta.dirname, "..")
let failures = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`)
  if (!ok) failures++
}

// Le script tel que l'application l'écrit : le littéral de updater.ts, évalué
// comme JavaScript l'évalue (les `\\` deviennent `\`).
const source = fs.readFileSync(path.join(ROOT, "src/main/updater.ts"), "utf8")
const start = source.indexOf("export const WIN_SCRIPT = `")
const body = source.slice(start + "export const WIN_SCRIPT = `".length, source.indexOf("\n`\n", start) + 1)
if (body.includes("${")) throw new Error("WIN_SCRIPT holds a template expression; this check cannot evaluate it")
const WIN_SCRIPT = new Function("return `" + body + "`")()

const { startUpdateHelper } = await import(pathToFileURL(path.join(ROOT, "src/main/update-helper.ts")).href)

// Des espaces partout, comme « Zyvro Studio » et un nom d'utilisateur composé.
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zyvro update ")))
const installDir = path.join(work, "Programs", "Zyvro Studio")
const updates = path.join(work, "Roaming", "zyvro-desktop", "updates")
const stage = path.join(updates, "stage")
fs.mkdirSync(path.join(installDir, "resources"), { recursive: true })
fs.mkdirSync(path.join(stage, "resources"), { recursive: true })
fs.writeFileSync(path.join(installDir, "resources", "app.asar"), "old")
fs.writeFileSync(path.join(stage, "resources", "app.asar"), "new")
// L'exécutable relancé à la fin : un programme qui s'arrête aussitôt.
const exe = path.join(installDir, "Zyvro Studio.exe")
fs.copyFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), exe)

const script = path.join(updates, "apply.ps1")
const ready = path.join(updates, "apply.ready")
const commit = path.join(updates, "apply.commit")
const journal = path.join(updates, "apply.log")
const bootstrap = path.join(updates, "apply-bootstrap.log")
fs.writeFileSync(script, "\uFEFF" + WIN_SCRIPT, "utf8")

// Le « processus de l'application » : celui que le script attend.
const appProc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })

const args = [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
  "-ProcId", String(appProc.pid),
  "-InstallDir", installDir,
  "-Stage", stage,
  "-Exe", exe,
  "-Version", "0.1.0-alpha.99",
  "-Log", journal,
  "-Ready", ready,
  "-Commit", commit,
]
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const show = () => {
  for (const f of [bootstrap, journal]) {
    console.log(`---- ${path.basename(f)}`)
    console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(absent)")
  }
}

let started = false
try {
  await startUpdateHelper(powershell, args, updates, ready, bootstrap)
  started = true
} catch (err) {
  check("**l'auxiliaire PowerShell démarre et se dit prêt**", false, err.message)
  show()
}
if (started) {
  check("**l'auxiliaire PowerShell démarre et se dit prêt**", true)
  // Quitter : ce que fait `will-quit`, puis la fin du processus.
  fs.writeFileSync(commit, "quit")
  await new Promise((r) => setTimeout(r, 300))
  appProc.kill()
  const until = Date.now() + 60_000
  const done = () => fs.existsSync(journal) && /relanc/.test(fs.readFileSync(journal, "utf8"))
  while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  const asar = fs.readFileSync(path.join(installDir, "resources", "app.asar"), "utf8")
  check("**la nouvelle version est posée**", asar === "new", `app.asar = ${asar}`)
  check("l'ancienne ne traîne pas", !fs.existsSync(path.join(installDir, "resources.old")))
  check("le journal le dit", done() && /fait/.test(fs.readFileSync(journal, "utf8")))
  if (failures) show()
} else {
  appProc.kill()
}

fs.rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? "\nLa mise à jour Windows se pose avec le vrai PowerShell." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
