// La proposition de mise à jour.
//
// Ce qui casse en silence ici :
//
// 1. **Comparer des versions comme du texte.** « alpha.10 » passe avant
//    « alpha.9 » en texte : l'application proposerait de revenir en arrière,
//    ou ne verrait jamais la dixième.
//
// 2. **Le mauvais installeur.** Un Mac Intel qui prend l'image arm64 installe
//    une application qui ne démarre pas.
//
// 3. **Une empreinte introuvable.** Le tableau des notes garde les noms avec
//    leurs espaces, GitHub les change en points : sans rapprochement, aucun
//    fichier n'est jamais vérifié.
//
// 4. **La fenêtre qui choisit ce qu'on exécute.** Elle dit « télécharge » et
//    « installe » ; l'adresse et le fichier sont gardés au principal, et le
//    chemin exécuté est revérifié.
//
//     node scripts/check-update.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-update-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/shared/update").replace(/\\/g, "/")}"\n`)
await build({ entryPoints: [path.join(dir, "h.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", absWorkingDir: ROOT, logLevel: "silent" })
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

check("**alpha.10 est plus récente qu'alpha.9**", t.compareVersions("0.1.0-alpha.10", "0.1.0-alpha.9") > 0)
check("la version finale passe devant ses pré-versions", t.compareVersions("0.1.0", "0.1.0-beta.3") > 0)
check("beta après alpha", t.compareVersions("0.1.0-beta.1", "0.1.0-alpha.20") > 0)
check("le `v` du tag ne compte pas", t.compareVersions("v0.1.0-alpha.9", "0.1.0-alpha.9") === 0)
check("0.2.0 après 0.1.9", t.compareVersions("0.2.0", "0.1.9") > 0)
check("un tag qui n'est pas une version n'est pas plus récent", t.compareVersions("nightly", "0.1.0") === 0)

const asset = (name) => ({ name, browser_download_url: `https://x/${name}`, size: 1 })
const release = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://x/${tag}`,
  assets: [
    asset(`Zyvro.Studio-${tag.slice(1)}-arm64.dmg`),
    asset(`Zyvro.Studio-${tag.slice(1)}.dmg`),
    asset(`Zyvro.Studio-${tag.slice(1)}-mac.zip`),
    asset(`Zyvro.Studio.Setup.${tag.slice(1)}.exe`),
  ],
  ...extra,
})
{
  // GitHub trie par date : alpha.9 republiée arrive en tête.
  const liste = [release("v0.1.0-alpha.9"), release("v0.1.0-alpha.16"), release("v0.1.0-alpha.12"), release("v0.1.0-alpha.20", { draft: true })]
  check("**la plus récente par sa version, pas par l'ordre de la liste**", t.newestRelease(liste)?.tag_name === "v0.1.0-alpha.16")
  check("un brouillon n'est jamais proposé", t.newestRelease(liste)?.tag_name !== "v0.1.0-alpha.20")
  const r = release("v0.1.0-alpha.16")
  check("**Mac Apple Silicon : l'image arm64**", t.pickAsset(r.assets, "darwin", "arm64")?.name === "Zyvro.Studio-0.1.0-alpha.16-arm64.dmg")
  check("**Mac Intel : l'autre image, pas l'arm64**", t.pickAsset(r.assets, "darwin", "x64")?.name === "Zyvro.Studio-0.1.0-alpha.16.dmg")
  check("Windows : l'installeur", t.pickAsset(r.assets, "win32", "x64")?.name === "Zyvro.Studio.Setup.0.1.0-alpha.16.exe")
  check("Linux : rien, il n'y a pas d'installeur", t.pickAsset(r.assets, "linux", "x64") === null)
}
{
  // Le tableau tel que la publication l'écrit dans les notes.
  const notes = [
    "## Checksums",
    "",
    "| File | SHA-256 |",
    "|---|---|",
    "| `Zyvro Studio Setup 0.1.0-alpha.16.exe` | `98198653526e78d14956a6fac33e2eb6232176a03daab8d014139c38cdc711ec` |",
    "| `Zyvro Studio-0.1.0-alpha.16-arm64.dmg` | `84233d1ee9d1db9e39a8e9e4900847dc785252443504acf19f653cd02b4bdca6` |",
    "| `Zyvro Studio-0.1.0-alpha.16.dmg` | `7ecb3cccef1ce4e4c0e6c257ff116156bac35dfe4d6bd93498c77c83223afbf2` |",
  ].join("\n")
  check("**l'empreinte se retrouve malgré les espaces devenus des points**", t.checksumFrom(notes, "Zyvro.Studio.Setup.0.1.0-alpha.16.exe")?.startsWith("98198653"))
  check("et l'image Intel n'est pas confondue avec l'arm64", t.checksumFrom(notes, "Zyvro.Studio-0.1.0-alpha.16.dmg")?.startsWith("7ecb3ccc"))
  check("un fichier absent du tableau : pas d'empreinte", t.checksumFrom(notes, "autre.exe") === null)
}
{
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  check("**la fenêtre ne nomme ni l'adresse ni le fichier**", /ipcMain\.handle\("update:download", async \(event\) =>/.test(ipc) && /ipcMain\.handle\("update:install", async \(\) =>/.test(ipc))
  const up = readFileSync(path.join(ROOT, "src/main/updater.ts"), "utf8")
  check("le fichier exécuté doit être dans le dossier des mises à jour", /path\.dirname\(resolved\) !== path\.resolve\(dir\)/.test(up))
  check("**un fichier dont l'empreinte ne correspond pas est effacé, pas installé**", /empreinte !== sha256/.test(up) && /fs\.rm\(file/.test(up))
  const st = readFileSync(path.join(ROOT, "src/renderer/state/update.ts"), "utf8")
  check("la vérification automatique suit le réglage", /getSettings\(\)\.checkForUpdates/.test(st))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUne version plus récente se voit, se télécharge vérifiée, et s'installe quand on le demande.")
