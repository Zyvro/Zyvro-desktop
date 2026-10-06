import { app, net, shell, type WebContents } from "electron"
import { createHash } from "node:crypto"
import * as nodeFs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { startUpdateHelper } from "./update-helper"
import { checksumFrom, compareVersions, newestRelease, pickUpdate, type PackageKind, type Release } from "../shared/update"

// Les mises à jour de l'application.
//
// Demander à GitHub la release la plus récente, la proposer si elle est plus
// récente que celle qui tourne, la télécharger en vérifiant son empreinte, et
// l'installer **sur place** : l'application se ferme, un petit script pose la
// nouvelle version sur l'ancienne, et la relance. Rien à ouvrir, rien à glisser.
//
// **Ce qu'on télécharge** (`pickUpdate`, shared/update.ts). D'abord le
// correctif : notre code et le moteur, sans Electron — une fraction du paquet
// complet. Quand Electron change, le paquet complet : le `.zip` sur Mac,
// remplacé en entier ; l'installeur sous Windows, lancé sans questions. Et
// seulement quand l'application ne peut pas s'écrire là où elle est — un
// dossier protégé, ou la copie en lecture seule que macOS lance depuis
// Téléchargements — l'image disque à ouvrir soi-même, comme avant.
//
// **Quand ça s'applique.** Au moment où l'application quitte vraiment : le
// remplacement est autorisé sur `will-quit`, après que les fenêtres ont demandé quoi faire
// des fichiers modifiés. Annuler la fermeture n'applique rien ; la mise à jour
// attend la prochaine.
//
// **Ce que ça vérifie, et ce que ça ne vérifie pas.** L'empreinte SHA-256 est
// lue dans les notes de la même release : elle prouve que le fichier est arrivé
// entier, pas qu'il vient de nous — quelqu'un qui pourrait remplacer le paquet
// pourrait remplacer les notes aussi. C'est la signature des paquets qui fera la
// différence, et l'interface ne prétend rien de plus.

const REPO = "Zyvro/Zyvro-desktop"

// **Le système de fichiers sans asar.** Dans Electron, `fs` voit chaque
// `app.asar` comme un dossier : c'est ce qui permet à l'application de lire son
// propre code. Mais un correctif contient justement un `app.asar` — et alors
// `access` le dit absent (« The update package is not shaped like this app »),
// et `rm` du dossier déplié échoue sur ENOTEMPTY, en essayant de vider ce
// faux dossier. Vécu sur un Mac en alpha.25, reproduit ici avec le vrai
// Electron. `original-fs` est le module d'Electron qui voit les fichiers tels
// qu'ils sont ; hors d'Electron (les vérifications sous Node), c'est `fs`.
function fsBrut(): typeof nodeFs {
  try {
    return module.require("original-fs") as typeof nodeFs
  } catch {
    return nodeFs
  }
}
const fs = {
  access: (p: string) => fsBrut().promises.access(p),
  mkdir: (p: string, o: nodeFs.MakeDirectoryOptions) => fsBrut().promises.mkdir(p, o),
  readdir: (p: string) => fsBrut().promises.readdir(p),
  rm: (p: string, o: nodeFs.RmOptions) => fsBrut().promises.rm(p, o),
  writeFile: (p: string, data: string, o?: nodeFs.WriteFileOptions) => fsBrut().promises.writeFile(p, data, o),
}
const createWriteStream = (p: string) => fsBrut().createWriteStream(p)

export type UpdateInfo = {
  current: string
  latest: string
  /** La page de la release, pour lire ce qui a changé. */
  url: string
  /** `patch` et `full` s'installent seuls ; `manual` ouvre l'image disque. */
  kind: PackageKind
  asset: { name: string; url: string; size: number; sha256: string | null } | null
}

const dossierMaj = (): string => path.join(app.getPath("userData"), "updates")

// L'application `.app` qui tourne : `…/Zyvro Studio.app/Contents/MacOS/Zyvro Studio`.
function bundleMac(): string | null {
  const bundle = path.resolve(process.execPath, "..", "..", "..")
  return bundle.endsWith(".app") ? bundle : null
}

async function inscriptible(dir: string): Promise<boolean> {
  const essai = path.join(dir, `.zyvro-write-test-${process.pid}`)
  try {
    await fs.writeFile(essai, "")
    await fs.rm(essai, { force: true })
    return true
  } catch {
    return false
  }
}

// canUpdateInPlace : l'application peut-elle se réécrire là où elle est ?
// Essayer d'écrire, pas lire des droits : sous Windows, `access` dit oui à un
// dossier de Program Files où l'écriture sera refusée.
export async function canUpdateInPlace(): Promise<boolean> {
  if (!app.isPackaged) return false
  if (process.platform === "darwin") {
    const bundle = bundleMac()
    // Une application lancée depuis Téléchargements sans avoir été déplacée
    // tourne depuis une copie en lecture seule (App Translocation).
    if (!bundle || bundle.includes("/AppTranslocation/")) return false
    return (await inscriptible(path.dirname(bundle))) && (await inscriptible(path.join(bundle, "Contents")))
  }
  if (process.platform === "win32") return inscriptible(path.dirname(process.execPath))
  return false
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Zyvro-Studio" },
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} to the update check.`)
  const releases = (await res.json()) as Release[]
  const newest = newestRelease(Array.isArray(releases) ? releases : [])
  const current = app.getVersion()
  if (!newest || compareVersions(newest.tag_name, current) <= 0) return null
  const choix = pickUpdate(newest, process.platform, process.arch, process.versions.electron, await canUpdateInPlace())
  return {
    current,
    latest: newest.tag_name.replace(/^v/, ""),
    url: newest.html_url,
    kind: choix?.kind ?? "manual",
    asset: choix
      ? {
          name: choix.asset.name,
          url: choix.asset.browser_download_url,
          size: choix.asset.size,
          sha256: checksumFrom(newest.body, choix.asset.name),
        }
      : null,
  }
}

// download : le fichier dans le dossier de mises à jour de l'application,
// empreinte calculée pendant la réception. Un fichier dont l'empreinte ne
// correspond pas est effacé : on ne propose pas d'installer ce qui est arrivé
// abîmé.
export async function downloadUpdate(
  info: UpdateInfo,
  target: WebContents
): Promise<{ file: string; verified: boolean }> {
  if (downloading) throw new Error("An update is already downloading in another window. Please wait.")
  downloading = true
  try { return await fetchUpdate(info, target) }
  finally { downloading = false }
}

async function fetchUpdate(info: UpdateInfo, target: WebContents): Promise<{ file: string; verified: boolean }> {
  if (enAttente || preparing) throw new Error("An update is already prepared. Quit the app to finish installing it.")
  if (!info.asset) throw new Error("There is no installer for this computer in that release.")
  const { name, url, size, sha256 } = info.asset
  // Le nom vient de GitHub : on n'en garde que le dernier segment.
  const dir = dossierMaj()
  await fs.mkdir(dir, { recursive: true })
  // Les paquets des fois précédentes, déjà posés ou abandonnés : plus de cent
  // Mo chacun pour les complets. Le journal reste.
  // Un reste qu'on n'arrive pas à effacer ne doit pas empêcher de télécharger :
  // le nouveau paquet a son propre nom.
  for (const vieux of await fs.readdir(dir)) {
    if (vieux !== JOURNAL) await fs.rm(path.join(dir, vieux), { recursive: true, force: true }).catch(() => undefined)
  }
  const file = path.join(dir, path.basename(name))

  const res = await net.fetch(url, { headers: { "User-Agent": "Zyvro-Studio" } })
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`)
  const hash = createHash("sha256")
  let recu = 0
  let annonce = 0
  try {
    // pipeline handles both network and filesystem errors, including a disk
    // full while waiting for drain. A bare WriteStream error crashed Electron.
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      async function* (source) {
        for await (const value of source) {
          hash.update(value)
          recu += value.length
          const pourcent = size > 0 ? Math.floor((recu / size) * 100) : 0
          if (pourcent !== annonce && !target.isDestroyed()) {
            annonce = pourcent
            target.send("update:progress", { received: recu, total: size })
          }
          yield value
        }
      },
      createWriteStream(file)
    )
  } catch (error) {
    await fs.rm(file, { force: true }).catch(() => undefined)
    throw error
  }

  const empreinte = hash.digest("hex")
  if (sha256 && empreinte !== sha256) {
    await fs.rm(file, { force: true })
    throw new Error("The downloaded file does not match the checksum published with the release. Nothing was installed.")
  }
  return { file, verified: sha256 !== null }
}

// ---- installer -----------------------------------------------------------------

const JOURNAL = "apply.log"

// Le script qui pose la mise à jour sur un Mac, une fois l'application fermée.
// Tout ce qu'il remplace, il le prépare d'abord à côté (`.new`), puis échange
// par deux renommages : une copie qui échoue à mi-chemin ne laisse jamais une
// application à moitié écrite. Et quoi qu'il arrive, il relance l'application —
// la nouvelle, ou l'ancienne intacte.
export const MAC_SCRIPT = `#!/bin/bash
# Zyvro Studio : pose une mise à jour une fois l'application fermée.
PID="$1"; APP="$2"; STAGE="$3"
exec >>"$4" 2>&1
echo "== $(date) : mise à jour de $APP"
for _ in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "toujours ouverte, rien n'est touché"; exit 1; fi
relancer() { open "$APP"; }
if [ -d "$STAGE/Resources" ]; then
  C="$APP/Contents"
  rm -rf "$C/Resources.new" "$C/Resources.old"
  if ! ditto "$STAGE/Resources" "$C/Resources.new"; then
    echo "copie ratée"; rm -rf "$C/Resources.new"; relancer; exit 1
  fi
  if mv "$C/Resources" "$C/Resources.old" && mv "$C/Resources.new" "$C/Resources"; then
    cp "$STAGE/Info.plist" "$C/Info.plist"
    rm -rf "$C/Resources.old"
  else
    echo "échange raté, retour à l'ancienne"
    [ -d "$C/Resources" ] || mv "$C/Resources.old" "$C/Resources"
    rm -rf "$C/Resources.new"; relancer; exit 1
  fi
  # L'exécutable principal et le sceau viennent avec : c'est eux qui portent
  # la signature Developer ID de cette version, et la poser telle quelle est
  # ce qui garde les autorisations de macOS d'une mise à jour à l'autre.
  for D in MacOS _CodeSignature; do
    [ -d "$STAGE/$D" ] || continue
    rm -rf "$C/$D.new"
    if ditto "$STAGE/$D" "$C/$D.new"; then
      rm -rf "$C/$D.old"; mv "$C/$D" "$C/$D.old" 2>/dev/null; mv "$C/$D.new" "$C/$D" && rm -rf "$C/$D.old"
    else
      echo "copie de $D ratée"; rm -rf "$C/$D.new"
    fi
  done
  # Une signature qui ne se vérifie plus empêcherait l'application de
  # démarrer : en dernier recours seulement, on la refait ad hoc.
  if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
    echo "signature invalide après le correctif : re-signature ad hoc"
    codesign --force --deep --sign - "$APP" || echo "signature ad hoc ratée"
  fi
else
  NEW=$(find "$STAGE" -maxdepth 1 -name '*.app' | head -n 1)
  if [ -z "$NEW" ]; then echo "pas d'application dans le paquet"; relancer; exit 1; fi
  rm -rf "$APP.new" "$APP.old"
  if ! ditto "$NEW" "$APP.new"; then
    echo "copie ratée"; rm -rf "$APP.new"; relancer; exit 1
  fi
  if mv "$APP" "$APP.old" && mv "$APP.new" "$APP"; then
    rm -rf "$APP.old"
  else
    echo "échange raté, retour à l'ancienne"
    [ -d "$APP" ] || mv "$APP.old" "$APP"
    rm -rf "$APP.new"; relancer; exit 1
  fi
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
rm -rf "$STAGE"
echo "fait"
relancer
`

// Le même sous Windows, en PowerShell, présent partout depuis Windows 7. Le
// dossier `resources` ne se renomme pas tant qu'un fichier y est ouvert : le
// moteur et les auxiliaires de terminal peuvent survivre au processus principal.
// On arrête ceux de cette installation seulement, après sa fermeture.
export const WIN_SCRIPT = `param([int]$ProcId, [string]$InstallDir, [string]$Stage, [string]$Exe, [string]$Version, [string]$Log, [string]$Ready, [string]$Commit, [string]$Installer)
$ErrorActionPreference = 'Stop'
function Note($m) { Add-Content -LiteralPath $Log -Encoding UTF8 -Value "$(Get-Date -Format o) $m" }
function StopLeftovers {
  $resourcesPrefix = (Join-Path $InstallDir 'resources').TrimEnd('\\') + '\\'
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $location = $_.Path
    $_.Id -ne $PID -and $location -and ($location -eq $Exe -or $location.StartsWith($resourcesPrefix, [StringComparison]::OrdinalIgnoreCase))
  } | Stop-Process -Force -ErrorAction SilentlyContinue
}
Note "mise à jour de $InstallDir vers $Version"
# Started BEFORE quitting, from the updates folder (never inside resources).
# A canceled close must not install anything, even if the app later crashes.
if ($Ready) {
  Set-Content -LiteralPath $Ready -Value 'ready'
  while (-not (Test-Path -LiteralPath $Commit)) {
    if (-not (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) { Note 'fermeture sans confirmation'; exit 1 }
    Start-Sleep -Milliseconds 100
  }
}
$p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if ($p) { $p.WaitForExit(300000) | Out-Null }
if (Get-Process -Id $ProcId -ErrorAction SilentlyContinue) { Note "toujours ouverte, rien n'est touché"; exit 1 }
$res = Join-Path $InstallDir 'resources'; $new = "$res.new"; $old = "$res.old"
$moved = $false
try {
  StopLeftovers
  if ($Installer) {
    # NSIS requires /D last, without quotes, including for paths with spaces.
    $setup = Start-Process -FilePath $Installer -ArgumentList "/S --updated /D=$InstallDir" -WorkingDirectory (Split-Path -Parent $Log) -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "installer exited ($($setup.ExitCode))" }
    Note 'fait (installeur)'
  } else {
    # Preserve a backup if an earlier attempt was interrupted between renames.
    if (-not (Test-Path -LiteralPath $res) -and (Test-Path -LiteralPath $old)) {
      Rename-Item -LiteralPath $old -NewName 'resources'
    }
    Remove-Item -LiteralPath $new, $old -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Join-Path $Stage 'resources') -Destination $new -Recurse -Force
    for ($i = 0; $i -lt 50 -and -not $moved; $i++) {
      try { Rename-Item -LiteralPath $res -NewName 'resources.old'; $moved = $true }
      catch { if ($i -eq 49) { throw }; Start-Sleep -Milliseconds 300 }
    }
    Rename-Item -LiteralPath $new -NewName 'resources'
    $moved = $false
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    Note 'fait'
    # Registry metadata must never turn a successful swap into a rollback.
    Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |
      Where-Object { ([string](Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).InstallLocation).TrimEnd('\\') -eq $InstallDir.TrimEnd('\\') } |
      ForEach-Object { Set-ItemProperty $_.PSPath -Name DisplayVersion -Value $Version -ErrorAction SilentlyContinue }
  }
} catch {
  Note "mise à jour ratée : $_"
  if ($moved -and -not (Test-Path -LiteralPath $res)) {
    Rename-Item -LiteralPath $old -NewName 'resources' -ErrorAction Continue
    Note "ancienne version restaurée"
  }
} finally {
  Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
  if ($Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
  try {
    Start-Process -FilePath $Exe -WorkingDirectory $InstallDir
    Note 'application relancée'
  } catch { Note "relancement impossible : $_" }
  if ($Ready) { Remove-Item -LiteralPath $Ready, $Commit -Force -ErrorAction SilentlyContinue }
}
`

function lancer(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
    let err = ""
    child.stderr?.on("data", (d) => (err += String(d)))
    child.on("error", reject)
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)}: ${err.trim() || `code ${code}`}`))))
  })
}

async function existe(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

// deplier : le paquet ouvert dans un dossier à côté, et vérifié — un correctif
// qui n'a pas la forme attendue ne sera pas posé sur l'application.
export async function deplier(file: string, kind: PackageKind): Promise<string> {
  const stage = path.join(dossierMaj(), "stage")
  await fs.rm(stage, { recursive: true, force: true })
  await fs.mkdir(stage, { recursive: true })
  if (process.platform === "darwin") {
    if (kind === "patch") {
      await lancer("/usr/bin/tar", ["-xzf", file, "-C", stage])
      if (!(await existe(path.join(stage, "Resources", "app.asar"))) || !(await existe(path.join(stage, "Info.plist")))) {
        throw new Error("The update package is not shaped like this app. Nothing was installed.")
      }
    } else {
      await lancer("/usr/bin/ditto", ["-x", "-k", file, stage])
      if (!(await fs.readdir(stage)).some((n) => n.endsWith(".app"))) {
        throw new Error("The update package holds no app. Nothing was installed.")
      }
    }
    return stage
  }
  // Le tar de Windows (bsdtar, livré depuis Windows 10), par son chemin : un
  // autre `tar` dans le PATH lirait `C:` comme une machine distante.
  const tar =
    process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar"
  await lancer(tar, ["-xzf", path.relative(stage, file)], stage)
  if (!(await existe(path.join(stage, "resources", "app.asar")))) {
    throw new Error("The update package is not shaped like this app. Nothing was installed.")
  }
  return stage
}

let enAttente = false
let preparing = false
let downloading = false

// install : poser le paquet téléchargé. Le chemin est revérifié : il doit être
// dans le dossier de mises à jour, et nulle part ailleurs — la fenêtre ne
// choisit pas ce qu'on exécute.
export async function installUpdate(file: string, info: UpdateInfo): Promise<"quitting" | "opened"> {
  if (downloading) throw new Error("Wait for the update download to finish before installing.")
  if (preparing) throw new Error("The update is already being prepared. Please wait.")
  preparing = true
  try { return await prepareUpdate(file, info) }
  finally { preparing = false }
}

async function prepareUpdate(file: string, info: UpdateInfo): Promise<"quitting" | "opened"> {
  if (enAttente) { app.quit(); return "quitting" }
  const dir = dossierMaj()
  const resolved = path.resolve(file)
  if (path.dirname(resolved) !== path.resolve(dir)) throw new Error("Refused to install from outside the updates folder.")
  await fs.access(resolved)

  if (info.kind === "manual") {
    const err = await shell.openPath(resolved)
    if (err) throw new Error(err)
    return "opened"
  }

  const journal = path.join(dir, JOURNAL)
  let partir: () => void
  if (process.platform === "darwin") {
    const bundle = bundleMac()
    if (!bundle) throw new Error("This app is not running from an application bundle.")
    const stage = await deplier(resolved, info.kind)
    const script = path.join(dir, "apply.sh")
    await fs.writeFile(script, MAC_SCRIPT, { mode: 0o755 })
    partir = () =>
      spawn("/bin/bash", [script, String(process.pid), bundle, stage, journal], { detached: true, stdio: "ignore" }).unref()
  } else if (process.platform === "win32") {
    const installer = /\.exe$/i.test(resolved)
    const stage = installer ? "" : await deplier(resolved, info.kind)
    const script = path.join(dir, "apply.ps1")
    const ready = path.join(dir, "apply.ready")
    const commit = path.join(dir, "apply.commit")
    await fs.rm(ready, { force: true })
    await fs.rm(commit, { force: true })
    // Avec sa marque d'ordre des octets : PowerShell 5 lirait sinon les accents
    // de ses messages en ANSI.
    await fs.writeFile(script, "\uFEFF" + WIN_SCRIPT, "utf8")
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      "-ProcId",
      String(process.pid),
      "-InstallDir",
      path.dirname(process.execPath),
      ...(installer ? ["-Installer", resolved] : ["-Stage", stage]),
      "-Exe",
      process.execPath,
      "-Version",
      info.latest,
      "-Log",
      journal,
      "-Ready", ready,
      "-Commit", commit,
    ]
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    await startUpdateHelper(powershell, args, dir, ready, path.join(dir, "apply-bootstrap.log"))
    partir = () => fsBrut().writeFileSync(commit, "quit")
  } else {
    throw new Error("Updates install by themselves on macOS and Windows only.")
  }

  // Au moment où l'application quitte vraiment, pas avant : une fermeture
  // annulée (un fichier modifié, « Cancel ») n'applique rien, et la mise à jour
  // part à la suivante.
  if (!enAttente) {
    enAttente = true
    app.once("will-quit", partir)
  }
  app.quit()
  return "quitting"
}
