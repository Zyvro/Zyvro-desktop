import { app, net, shell, type WebContents } from "electron"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { checksumFrom, compareVersions, newestRelease, pickAsset, type Release } from "../shared/update"

// Les mises à jour de l'application.
//
// Demander à GitHub la release la plus récente, la proposer si elle est plus
// récente que celle qui tourne, la télécharger en vérifiant son empreinte, et
// lancer l'installation.
//
// **Ce que ça vérifie, et ce que ça ne vérifie pas.** L'empreinte SHA-256 est
// lue dans les notes de la même release : elle prouve que le fichier est arrivé
// entier, pas qu'il vient de nous — quelqu'un qui pourrait remplacer
// l'installeur pourrait remplacer les notes aussi. Les installeurs ne sont pas
// signés (RELEASE.md) ; c'est la signature qui fera la différence, et
// l'interface ne prétend rien de plus.
//
// **Comment ça s'installe.** Sous Windows, l'installeur se lance et
// l'application se ferme pour le laisser remplacer ses fichiers. Sur un Mac,
// l'image disque s'ouvre, et l'on glisse l'application sur la précédente : un
// remplacement automatique d'un paquet non signé ne peut pas être vérifié ici,
// et une mise à jour qui casse l'application à moitié est pire que deux gestes.

const REPO = "Zyvro/Zyvro-desktop"

export type UpdateInfo = {
  current: string
  latest: string
  /** La page de la release, pour lire ce qui a changé. */
  url: string
  asset: { name: string; url: string; size: number; sha256: string | null } | null
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
  const asset = pickAsset(newest.assets, process.platform, process.arch)
  return {
    current,
    latest: newest.tag_name.replace(/^v/, ""),
    url: newest.html_url,
    asset: asset
      ? {
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
          sha256: checksumFrom(newest.body, asset.name),
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
  if (!info.asset) throw new Error("There is no installer for this computer in that release.")
  const { name, url, size, sha256 } = info.asset
  // Le nom vient de GitHub : on n'en garde que le dernier segment.
  const dir = path.join(app.getPath("userData"), "updates")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, path.basename(name))

  const res = await net.fetch(url, { headers: { "User-Agent": "Zyvro-Studio" } })
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`)
  const hash = createHash("sha256")
  const out = createWriteStream(file)
  let recu = 0
  let annonce = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      recu += value.length
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()))
      // Une annonce par pour-cent, pas une par paquet réseau.
      const pourcent = size > 0 ? Math.floor((recu / size) * 100) : 0
      if (pourcent !== annonce && !target.isDestroyed()) {
        annonce = pourcent
        target.send("update:progress", { received: recu, total: size })
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }

  const empreinte = hash.digest("hex")
  if (sha256 && empreinte !== sha256) {
    await fs.rm(file, { force: true })
    throw new Error("The downloaded file does not match the checksum published with the release. Nothing was installed.")
  }
  return { file, verified: sha256 !== null }
}

// install : lancer l'installation du fichier téléchargé. Le chemin est
// revérifié : il doit être dans le dossier de mises à jour, et nulle part
// ailleurs — la fenêtre ne choisit pas quel programme on exécute.
export async function installUpdate(file: string): Promise<"quitting" | "opened"> {
  const dir = path.join(app.getPath("userData"), "updates")
  const resolved = path.resolve(file)
  if (path.dirname(resolved) !== path.resolve(dir)) throw new Error("Refused to run an installer from outside the updates folder.")
  await fs.access(resolved)
  if (process.platform === "win32" && /\.exe$/i.test(resolved)) {
    spawn(resolved, [], { detached: true, stdio: "ignore" }).unref()
    // Laisser l'installeur démarrer avant de fermer : il remplacera des
    // fichiers que cette application tient ouverts.
    setTimeout(() => app.quit(), 1500)
    return "quitting"
  }
  const err = await shell.openPath(resolved)
  if (err) throw new Error(err)
  return "opened"
}
