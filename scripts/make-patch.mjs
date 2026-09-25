// Le correctif de chaque machine, à côté des installeurs : ce qui change d'une
// version à l'autre, et rien d'Electron.
//
// Après `electron-builder`, `dist/` contient l'application dépliée de chaque
// architecture (`mac-arm64/Zyvro Studio.app`, `mac/…` pour Intel,
// `win-unpacked`). On en tire une archive :
//
//   Mac     : `Resources/` et `Info.plist`, pris dans `Contents/`
//   Windows : `resources/`
//
// nommée par `patchName` (shared/update.ts) — version, machine, architecture, et
// la version d'Electron pour laquelle elle vaut. L'application installée la
// télécharge et la pose sur elle-même (main/updater.ts).
//
//     node scripts/make-patch.mjs [dist]
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { build } from "esbuild"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.resolve(process.argv[2] ?? path.join(ROOT, "dist"))
const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version
const electron = JSON.parse(readFileSync(path.join(ROOT, "node_modules/electron/package.json"), "utf8")).version

// Le nom vient du même code que celui qui le cherche : deux copies d'une règle
// de nommage finissent toujours par diverger.
const tmp = path.join(ROOT, "node_modules", ".zyvro-make-patch")
mkdirSync(tmp, { recursive: true })
await build({
  entryPoints: [path.join(ROOT, "src/shared/update.ts")],
  outfile: path.join(tmp, "update.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
})
const { patchName } = createRequire(import.meta.url)(path.join(tmp, "update.cjs"))

// Les dossiers qu'electron-builder écrit, et l'architecture de chacun.
const DOSSIERS = [
  { dir: "mac-arm64", platform: "darwin", arch: "arm64" },
  { dir: "mac", platform: "darwin", arch: "x64" },
  { dir: "win-unpacked", platform: "win32", arch: "x64" },
  { dir: "win-arm64-unpacked", platform: "win32", arch: "arm64" },
]

let faits = 0
for (const { dir, platform, arch } of DOSSIERS) {
  const racine = path.join(DIST, dir)
  if (!existsSync(racine)) continue
  let cwd
  let entrees
  if (platform === "darwin") {
    const app = readdirSync(racine).find((n) => n.endsWith(".app"))
    if (!app) continue
    cwd = path.join(racine, app, "Contents")
    entrees = ["Resources", "Info.plist"]
  } else {
    cwd = racine
    entrees = ["resources"]
  }
  if (!existsSync(path.join(cwd, entrees[0], "app.asar"))) {
    throw new Error(`${cwd}: pas de ${entrees[0]}/app.asar — ce n'est pas une application empaquetée`)
  }
  const nom = patchName(version, platform, arch, electron)
  const sortie = path.join(DIST, nom)
  // Chemins relatifs des deux côtés : le tar de Git sous Windows lit `C:` comme
  // le nom d'une machine distante.
  const r = spawnSync("tar", ["-czf", path.relative(cwd, sortie), ...entrees], { cwd, stdio: "inherit" })
  if (r.status !== 0) throw new Error(`tar a échoué pour ${nom}`)
  console.log(`  • correctif  ${nom}  ${(statSync(sortie).size / 1024 / 1024).toFixed(1)} Mo`)
  faits++
}
// En CI, une release sans correctif laisserait chaque installation retomber sur
// le paquet complet sans que personne le voie : c'est une erreur.
if (faits === 0) {
  console.log("  • aucun dossier déplié dans dist/ : pas de correctif")
  if (process.env.CI) process.exit(1)
}
