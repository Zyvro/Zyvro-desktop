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

// Le « processus de l'application » : il lance l'auxiliaire lui-même, avec le
// vrai startUpdateHelper, puis quitte comme Electron (commit, puis fin) —
// l'auxiliaire doit lui survivre pour poser la mise à jour.
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const appScript = path.join(work, "fake app.mjs")
fs.writeFileSync(appScript, `
import fs from "node:fs"
const { startUpdateHelper } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "src/main/update-helper.ts")).href)})
const args = [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ${JSON.stringify(script)},
  "-ProcId", String(process.pid),
  "-InstallDir", ${JSON.stringify(installDir)},
  "-Stage", ${JSON.stringify(stage)},
  "-Exe", ${JSON.stringify(exe)},
  "-Version", "0.1.0-alpha.99",
  "-Log", ${JSON.stringify(journal)},
  "-Ready", ${JSON.stringify(ready)},
  "-Commit", ${JSON.stringify(commit)},
]
try {
  await startUpdateHelper(${JSON.stringify(powershell)}, args, ${JSON.stringify(updates)}, ${JSON.stringify(ready)}, ${JSON.stringify(bootstrap)})
} catch (err) {
  console.log("HELPER-FAILED " + err.message)
  process.exit(3)
}
console.log("HELPER-READY")
fs.writeFileSync(${JSON.stringify(commit)}, "quit")
setTimeout(() => process.exit(0), 300)
`)
const show = () => {
  for (const f of [bootstrap, journal]) {
    console.log(`---- ${path.basename(f)}`)
    console.log(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(absent)")
  }
}
const appOut = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", appScript], { stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  child.stderr.on("data", (d) => (out += d))
  child.on("exit", (code) => resolve({ code, out }))
})
check("**l'auxiliaire PowerShell démarre et se dit prêt**", appOut.out.includes("HELPER-READY"), appOut.out.trim().split("\n").filter((l) => !/Warning|Reparsing|type.: .module|trace-warnings/.test(l)).join(" | "))
if (appOut.out.includes("HELPER-READY")) {
  // L'application est partie : l'auxiliaire continue seul.
  const until = Date.now() + 60_000
  const done = () => fs.existsSync(journal) && /relanc/.test(fs.readFileSync(journal, "utf8"))
  while (!done() && Date.now() < until) await new Promise((r) => setTimeout(r, 250))
  const asar = fs.readFileSync(path.join(installDir, "resources", "app.asar"), "utf8")
  check("**l'application partie, l'auxiliaire pose la nouvelle version**", asar === "new", `app.asar = ${asar}`)
  check("l'ancienne ne traîne pas", !fs.existsSync(path.join(installDir, "resources.old")))
  check("le journal le dit", done() && /fait/.test(fs.readFileSync(journal, "utf8")))
}
if (failures) show()
// Laisser PowerShell relâcher ses fichiers avant le ménage.
await new Promise((r) => setTimeout(r, 1000))
fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
console.log(failures === 0 ? "\nLa mise à jour Windows se pose avec le vrai PowerShell." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
