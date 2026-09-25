// Le correctif déplié par le vrai Electron.
//
// Sous Node, `fs` voit un `app.asar` comme un fichier ; dans Electron, comme un
// dossier. C'est là que la mise à jour d'alpha.25 a cassé sur un Mac : le
// correctif déplié était déclaré « not shaped like this app » (son app.asar
// introuvable), puis le dossier déplié ne s'effaçait plus (ENOTEMPTY). Aucune
// vérification sous Node ne pouvait le voir. Celle-ci lance Electron, déplie un
// vrai correctif — un vrai app.asar dedans — et efface ce qu'elle a déplié.
//
//     node scripts/check-update-electron.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)

// Sous Linux sans écran, Electron ne démarre pas : la CI tourne sur Mac et
// Windows, où il démarre.
if (process.platform === "linux" && !process.env.DISPLAY) {
  console.log("  skip  pas d'écran pour Electron ici (xvfb-run pour l'essayer)")
  process.exit(0)
}

const dir = path.join(ROOT, "node_modules", ".zyvro-update-electron-check")
mkdirSync(dir, { recursive: true })
await build({
  entryPoints: [path.join(ROOT, "src/main/updater.ts")],
  outfile: path.join(dir, "updater.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron", "original-fs"],
  logLevel: "silent",
})

const travail = mkdtempSync(path.join(tmpdir(), "zyvro-update-electron-"))
try {
  // Un vrai correctif : un vrai app.asar, dans la forme de chaque système.
  const source = path.join(travail, "source")
  mkdirSync(path.join(source, "contenu"), { recursive: true })
  writeFileSync(path.join(source, "contenu", "package.json"), '{"name":"x","version":"9.9.9"}')
  const asar = require("@electron/asar")
  const mac = process.platform === "darwin"
  const racine = path.join(travail, "paquet")
  const resources = path.join(racine, mac ? "Resources" : "resources")
  mkdirSync(resources, { recursive: true })
  await asar.createPackage(path.join(source, "contenu"), path.join(resources, "app.asar"))
  if (mac) writeFileSync(path.join(racine, "Info.plist"), "<plist/>")
  const archive = path.join(travail, "correctif.tar.gz")
  const t = spawnSync("tar", ["-czf", path.relative(racine, archive), ...(mac ? ["Resources", "Info.plist"] : ["resources"])], { cwd: racine })
  if (t.status !== 0) throw new Error(`tar : ${t.stderr}`)

  writeFileSync(
    path.join(dir, "essai.cjs"),
    `const { app } = require("electron")
const path = require("path")
app.setPath("userData", ${JSON.stringify(path.join(travail, "donnees"))})
app.whenReady().then(async () => {
  const r = {}
  try {
    const u = require(${JSON.stringify(path.join(dir, "updater.cjs"))})
    const ofs = require("original-fs")
    const maj = path.join(app.getPath("userData"), "updates")
    ofs.mkdirSync(maj, { recursive: true })
    const fichier = path.join(maj, "correctif.tar.gz")
    ofs.copyFileSync(${JSON.stringify(archive)}, fichier)
    const stage = await u.deplier(fichier, "patch")
    r.deplie = ofs.existsSync(path.join(stage, ${JSON.stringify(mac ? "Resources" : "resources")}, "app.asar"))
    // Une seconde fois : le reste de la première doit s'effacer.
    const encore = await u.deplier(fichier, "patch")
    r.redeplie = ofs.existsSync(path.join(encore, ${JSON.stringify(mac ? "Resources" : "resources")}, "app.asar"))
  } catch (e) { r.erreur = e.message }
  console.log("RESULTAT " + JSON.stringify(r))
  app.exit(0)
})
`
  )
  const electron = require("electron")
  const r = spawnSync(electron, [path.join(dir, "essai.cjs"), "--no-sandbox"], { encoding: "utf8", timeout: 90_000 })
  const ligne = (r.stdout + r.stderr).split("\n").find((l) => l.startsWith("RESULTAT "))
  const res = ligne ? JSON.parse(ligne.slice(9)) : { erreur: `Electron n'a rien dit : ${r.stderr?.slice(0, 400)}` }

  let failures = 0
  const check = (name, ok, detail = "") => {
    if (ok) console.log(`  ok    ${name}`)
    else {
      console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
      failures++
    }
  }
  check("**dans Electron, le correctif déplié est reconnu, app.asar compris**", res.deplie === true, res.erreur)
  check("**et ce qu'il a déplié s'efface pour recommencer**", res.redeplie === true, res.erreur)
  if (failures) {
    console.log(`\n${failures} échec(s)`)
    process.exit(1)
  }
  console.log("\nLe vrai Electron déplie le correctif et le range.")
} finally {
  rmSync(travail, { recursive: true, force: true })
}
