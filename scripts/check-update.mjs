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
// 4. **Une mise à jour qui casse l'application.** Le correctif est posé par un
//    script, application fermée : une copie ratée doit laisser l'ancienne
//    intacte, et l'application doit revenir dans tous les cas. Le script du
//    Mac est lancé ici pour de vrai, sur une fausse application.
//
// 5. **Le correctif d'une autre version d'Electron.** Ses modules natifs ne
//    se chargeraient pas : il faut alors le paquet complet.
//
// 6. **La fenêtre qui choisit ce qu'on exécute.** Elle dit « télécharge » et
//    « installe » ; l'adresse et le fichier sont gardés au principal, et le
//    chemin exécuté est revérifié.
//
//     node scripts/check-update.mjs
import { build } from "esbuild"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
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
    asset(`Zyvro.Studio-${tag.slice(1)}-arm64-mac.zip`),
    asset(`Zyvro.Studio-${tag.slice(1)}-mac-arm64-app-e33.0.0.tar.gz`),
    asset(`Zyvro.Studio-${tag.slice(1)}-mac-x64-app-e33.0.0.tar.gz`),
    asset(`Zyvro.Studio-${tag.slice(1)}-win-x64-app-e33.0.0.tar.gz`),
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
  const r = release("v0.1.0-alpha.24")
  const choix = (platform, arch, electron, inPlace) => {
    const c = t.pickUpdate(r, platform, arch, electron, inPlace)
    return c ? `${c.kind} ${c.asset.name}` : null
  }
  check("**le correctif d'abord, sur un Mac Apple Silicon**", choix("darwin", "arm64", "33.0.0", true) === "patch Zyvro.Studio-0.1.0-alpha.24-mac-arm64-app-e33.0.0.tar.gz", choix("darwin", "arm64", "33.0.0", true))
  check("et le sien sur un Mac Intel", choix("darwin", "x64", "33.0.0", true) === "patch Zyvro.Studio-0.1.0-alpha.24-mac-x64-app-e33.0.0.tar.gz")
  check("**Electron a changé : le zip complet, de la bonne architecture**", choix("darwin", "arm64", "32.1.0", true) === "full Zyvro.Studio-0.1.0-alpha.24-arm64-mac.zip" && choix("darwin", "x64", "32.1.0", true) === "full Zyvro.Studio-0.1.0-alpha.24-mac.zip", choix("darwin", "x64", "32.1.0", true))
  check("**une application qui ne peut pas s'écrire : l'image à ouvrir**", choix("darwin", "arm64", "33.0.0", false) === "manual Zyvro.Studio-0.1.0-alpha.24-arm64.dmg")
  check("Windows : le correctif, sinon l'installeur sans questions", choix("win32", "x64", "33.0.0", true) === "patch Zyvro.Studio-0.1.0-alpha.24-win-x64-app-e33.0.0.tar.gz" && choix("win32", "x64", "33.0.0", false) === "full Zyvro.Studio.Setup.0.1.0-alpha.24.exe")
  check("Linux : rien", choix("linux", "x64", "33.0.0", true) === null)
  check(
    "**les versions 24 à 29 ne trouvent plus de correctif : elles prennent le paquet complet**",
    !t.patchName("0.1.0-alpha.30", "darwin", "arm64", "44.4.0").includes("-patch-e")
  )
  check("le nom du correctif ignore le `v` du tag", t.patchName("v1.0.0", "darwin", "arm64", "33.0.0") === "Zyvro.Studio-1.0.0-mac-arm64-app-e33.0.0.tar.gz")
}

// ---- le correctif fabriqué a la forme que l'application attend ----------------
{
  const dist = mkdtempSync(path.join(tmpdir(), "zyvro-patch-"))
  try {
    const contents = path.join(dist, "mac-arm64", "Zyvro Studio.app", "Contents")
    mkdirSync(path.join(contents, "Resources", "bin"), { recursive: true })
    writeFileSync(path.join(contents, "Resources", "app.asar"), "asar")
    writeFileSync(path.join(contents, "Resources", "bin", "zyvrod"), "moteur")
    writeFileSync(path.join(contents, "Info.plist"), "plist")
    mkdirSync(path.join(contents, "Frameworks", "Electron Framework.framework"), { recursive: true })
    writeFileSync(path.join(contents, "Frameworks", "Electron Framework.framework", "gros"), "electron")
    mkdirSync(path.join(dist, "win-unpacked", "resources"), { recursive: true })
    writeFileSync(path.join(dist, "win-unpacked", "resources", "app.asar"), "asar")
    writeFileSync(path.join(dist, "win-unpacked", "Zyvro Studio.exe"), "exe")
    const fait = spawnSync(process.execPath, [path.join(ROOT, "scripts/make-patch.mjs"), dist], { encoding: "utf8" })
    check("make-patch passe", fait.status === 0, fait.stderr || fait.stdout)
    const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version
    const electron = JSON.parse(readFileSync(path.join(ROOT, "node_modules/electron/package.json"), "utf8")).version
    const mac = path.join(dist, t.patchName(version, "darwin", "arm64", electron))
    const win = path.join(dist, t.patchName(version, "win32", "x64", electron))
    check("**le nom écrit est celui que l'application cherche**", existsSync(mac) && existsSync(win), fait.stdout)
    const liste = (f) => (existsSync(f) ? spawnSync("tar", ["-tzf", path.basename(f)], { cwd: dist, encoding: "utf8" }).stdout.split(/\r?\n/).map((l) => l.replace(/\/$/, "")).filter(Boolean).sort() : [])
    const lm = liste(mac)
    check("**Mac : Resources et Info.plist, rien d'Electron**", lm.includes("Resources/app.asar") && lm.includes("Resources/bin/zyvrod") && lm.includes("Info.plist") && !lm.some((l) => /Frameworks|MacOS/.test(l)), lm.join(" "))
    const lw = liste(win)
    check("Windows : resources seul, pas l'exécutable", lw.includes("resources/app.asar") && !lw.some((l) => /\.exe$/.test(l)), lw.join(" "))
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
}

// ---- le script du Mac, lancé pour de vrai --------------------------------------
//
// Sur une fausse application, avec `ditto`, `codesign`, `xattr` et `open`
// remplacés par des doublures qui écrivent ce qu'on leur demande. Pas sous
// Windows, qui n'a pas bash.
if (process.platform !== "win32") {
  const up = await import("node:fs").then(() => readFileSync(path.join(ROOT, "src/main/updater.ts"), "utf8"))
  const m = /export const MAC_SCRIPT = `([\s\S]*?)`\n/.exec(up)
  check("le script du Mac se lit dans updater.ts", m !== null)
  const racine = mkdtempSync(path.join(tmpdir(), "zyvro-apply-"))
  try {
    const script = path.join(racine, "apply.sh")
    writeFileSync(script, m[1], { mode: 0o755 })
    const bin = path.join(racine, "bin")
    mkdirSync(bin)
    const doublure = (nom, corps) => {
      writeFileSync(path.join(bin, nom), `#!/bin/bash\n${corps}\n`)
      chmodSync(path.join(bin, nom), 0o755)
    }
    const traces = path.join(racine, "traces")
    doublure("ditto", `[ -n "$DITTO_RATE" ] && exit 1; cp -R "$1" "$2"`)
    doublure("codesign", `echo "codesign $*" >> "${traces}"`)
    doublure("xattr", `echo "xattr $*" >> "${traces}"`)
    doublure("open", `echo "open $*" >> "${traces}"`)
    // Un PID qui n'existe plus : l'application est déjà fermée.
    const mort = spawnSync(process.execPath, ["-e", "0"]).pid
    const lancer = (app, stage, env = {}) =>
      spawnSync("/bin/bash", [script, String(mort), app, stage, path.join(racine, "apply.log")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
        encoding: "utf8",
      })
    const fausseApp = (nom, asar) => {
      const app = path.join(racine, nom)
      mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true })
      mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true })
      writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), asar)
      writeFileSync(path.join(app, "Contents", "Resources", "vieux-fichier"), "à retirer")
      writeFileSync(path.join(app, "Contents", "Info.plist"), "plist ancienne")
      writeFileSync(path.join(app, "Contents", "MacOS", "Zyvro Studio"), "electron")
      return app
    }
    const correctif = (nom, asar) => {
      const stage = path.join(racine, nom)
      mkdirSync(path.join(stage, "Resources"), { recursive: true })
      writeFileSync(path.join(stage, "Resources", "app.asar"), asar)
      writeFileSync(path.join(stage, "Info.plist"), "plist nouvelle")
      return stage
    }
    const lire = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null)

    // Le correctif.
    {
      const app = fausseApp("A.app", "v1")
      const stage = correctif("stage-a", "v2")
      rmSync(traces, { force: true })
      const r = lancer(app, stage)
      check("**le correctif remplace le code**", r.status === 0 && lire(path.join(app, "Contents/Resources/app.asar")) === "v2", lire(path.join(racine, "apply.log")))
      check("et l'Info.plist", lire(path.join(app, "Contents/Info.plist")) === "plist nouvelle")
      check("un fichier de l'ancienne version disparaît", !existsSync(path.join(app, "Contents/Resources/vieux-fichier")))
      check("Electron n'est pas touché", lire(path.join(app, "Contents/MacOS/Zyvro Studio")) === "electron")
      check("rien ne traîne à côté", !existsSync(path.join(app, "Contents/Resources.old")) && !existsSync(path.join(app, "Contents/Resources.new")) && !existsSync(stage))
      const t2 = lire(traces) ?? ""
      check("**la signature ad hoc est refaite, puis l'application relancée**", t2.includes(`codesign --force --deep --sign - ${app}`) && t2.trim().endsWith(`open ${app}`), t2)
    }
    // Une copie qui échoue.
    {
      const app = fausseApp("B.app", "v1")
      const stage = correctif("stage-b", "v2")
      rmSync(traces, { force: true })
      const r = lancer(app, stage, { DITTO_RATE: "1" })
      check("**une copie ratée laisse l'ancienne intacte**", r.status !== 0 && lire(path.join(app, "Contents/Resources/app.asar")) === "v1" && lire(path.join(app, "Contents/Info.plist")) === "plist ancienne")
      check("et la relance quand même", (lire(traces) ?? "").includes(`open ${app}`))
    }
    // Le paquet complet.
    {
      const app = fausseApp("C.app", "v1")
      const stage = path.join(racine, "stage-c")
      const nouvelle = fausseApp(path.join("stage-c", "Zyvro Studio.app"), "v3")
      writeFileSync(path.join(nouvelle, "Contents", "MacOS", "Zyvro Studio"), "electron neuf")
      rmSync(traces, { force: true })
      const r = lancer(app, stage)
      check("**le paquet complet remplace toute l'application**", r.status === 0 && lire(path.join(app, "Contents/Resources/app.asar")) === "v3" && lire(path.join(app, "Contents/MacOS/Zyvro Studio")) === "electron neuf", lire(path.join(racine, "apply.log")))
      check("sans laisser l'ancienne à côté", !existsSync(`${app}.old`) && !existsSync(`${app}.new`))
    }
    // L'application encore ouverte : rien n'est touché.
    {
      const app = fausseApp("D.app", "v1")
      const stage = correctif("stage-d", "v2")
      const r = spawnSync("/bin/bash", ["-c", `sed 's/seq 1 600/seq 1 2/' "${script}" > "${script}.court"; bash "${script}.court" ${process.pid} "${app}" "${stage}" "${path.join(racine, "apply.log")}"`], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      })
      check("**l'application toujours ouverte : rien n'est touché**", r.status !== 0 && lire(path.join(app, "Contents/Resources/app.asar")) === "v1")
    }
  } finally {
    rmSync(racine, { recursive: true, force: true })
  }
}

// ---- le script de Windows, lancé pour de vrai ----------------------------------
//
// Sous Windows seulement (la CI de Windows le fait tourner), sur une fausse
// installation. L'« application » relancée est `hostname.exe`, qui rend la main
// tout de suite.
if (process.platform === "win32") {
  const up = readFileSync(path.join(ROOT, "src/main/updater.ts"), "utf8")
  const m = /export const WIN_SCRIPT = `([\s\S]*?)`\n/.exec(up)
  check("le script de Windows se lit dans updater.ts", m !== null)
  // Le texte tel que le module l'écrit : les `\\` du gabarit deviennent `\`.
  const texte = m[1].replace(/\\\\/g, "\\")
  const racine = mkdtempSync(path.join(tmpdir(), "zyvro-apply-"))
  try {
    const script = path.join(racine, "apply.ps1")
    writeFileSync(script, "\uFEFF" + texte, "utf8")
    const install = path.join(racine, "Zyvro Studio")
    mkdirSync(path.join(install, "resources", "bin"), { recursive: true })
    writeFileSync(path.join(install, "resources", "app.asar"), "v1")
    writeFileSync(path.join(install, "resources", "vieux-fichier"), "à retirer")
    writeFileSync(path.join(install, "Zyvro Studio.exe"), "electron")
    const stage = path.join(racine, "stage")
    mkdirSync(path.join(stage, "resources", "bin"), { recursive: true })
    writeFileSync(path.join(stage, "resources", "app.asar"), "v2")
    writeFileSync(path.join(stage, "resources", "bin", "zyvrod.exe"), "moteur")
    const mort = spawnSync(process.execPath, ["-e", "0"]).pid
    const journal = path.join(racine, "apply.log")
    const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "HOSTNAME.EXE")
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ProcId", String(mort), "-InstallDir", install, "-Stage", stage, "-Exe", exe, "-Version", "9.9.9", "-Log", journal],
      { encoding: "utf8" }
    )
    const lire = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null)
    check("**Windows : le correctif remplace resources**", r.status === 0 && lire(path.join(install, "resources", "app.asar")) === "v2", `${r.stderr}\n${lire(journal)}`)
    check("Windows : le moteur neuf est là, l'ancien fichier parti", lire(path.join(install, "resources", "bin", "zyvrod.exe")) === "moteur" && !existsSync(path.join(install, "resources", "vieux-fichier")))
    check("Windows : l'exécutable n'est pas touché", lire(path.join(install, "Zyvro Studio.exe")) === "electron")
    check("Windows : rien ne traîne", !existsSync(path.join(install, "resources.old")) && !existsSync(path.join(install, "resources.new")) && !existsSync(stage))
    check("Windows : le journal dit « fait »", /fait/.test(lire(journal) ?? ""), lire(journal))
  } finally {
    rmSync(racine, { recursive: true, force: true })
  }
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
  check("**le script part quand l'application quitte vraiment, pas avant**", /app\.once\("will-quit", partir\)/.test(up))
  check("un correctif ne se pose pas s'il n'a pas la forme attendue", /is not shaped like this app/.test(up))
  check("**un fichier dont l'empreinte ne correspond pas est effacé, pas installé**", /empreinte !== sha256/.test(up) && /fs\.rm\(file/.test(up))
  const st = readFileSync(path.join(ROOT, "src/renderer/state/update.ts"), "utf8")
  check("la vérification automatique suit le réglage", /getSettings\(\)\.checkForUpdates/.test(st))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUne version plus récente se voit, se télécharge vérifiée, et se pose sur l'application sans rien casser.")
