// Savoir qu'une version plus récente existe, et laquelle télécharger.
//
// L'application n'avait pas de mise à jour : une nouvelle version voulait dire
// aller la chercher soi-même sur GitHub, et la plupart des gens ne savaient pas
// qu'elle existait. Ce module est la partie pure : comparer deux versions,
// choisir l'installeur de cette machine parmi les fichiers d'une release, et
// lire son empreinte dans les notes. `scripts/check-update.mjs`.

// ---- les versions ------------------------------------------------------------
//
// `0.1.0-alpha.10` est plus récente que `0.1.0-alpha.9` : les parties
// numériques d'une pré-version se comparent en nombres, pas en texte (en texte,
// « 10 » passe avant « 9 »). Et `0.1.0` est plus récente que `0.1.0-beta.3` :
// une version sans suffixe est la version finale.

export function parseVersion(v: string): { core: number[]; pre: (string | number)[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  }
}

/** Positif si `a` est plus récente que `b`, négatif si plus ancienne, 0 si égales. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    if (typeof p === "number" && typeof q === "number") return p - q
    if (typeof p === "number") return -1
    if (typeof q === "number") return 1
    return p < q ? -1 : 1
  }
  return 0
}

// ---- la release à proposer -------------------------------------------------

export type ReleaseAsset = { name: string; browser_download_url: string; size: number }
export type Release = {
  tag_name: string
  html_url: string
  body?: string | null
  draft?: boolean
  prerelease?: boolean
  assets: ReleaseAsset[]
}

// newestRelease : la plus récente, par sa version et pas par l'ordre de la
// liste — GitHub trie par date de création, et une release republiée remonte.
export function newestRelease(releases: Release[]): Release | null {
  let best: Release | null = null
  for (const r of releases) {
    if (r.draft || !parseVersion(r.tag_name)) continue
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = r
  }
  return best
}

// pickAsset : l'installeur de cette machine.
//
// Les noms sont ceux qu'electron-builder écrit, où GitHub a changé les espaces
// en points : `Zyvro.Studio-0.1.0-alpha.9-arm64.dmg` pour un Mac Apple
// Silicon, `Zyvro.Studio-0.1.0-alpha.9.dmg` pour un Mac Intel,
// `Zyvro.Studio.Setup.0.1.0-alpha.9.exe` pour Windows. Un Mac Intel qui
// prendrait l'image arm64 ouvrirait une application qui ne démarre pas.
export function pickAsset(assets: ReleaseAsset[], platform: string, arch: string): ReleaseAsset | null {
  if (platform === "win32") return assets.find((a) => /\.exe$/i.test(a.name)) ?? null
  if (platform !== "darwin") return null
  const dmgs = assets.filter((a) => /\.dmg$/i.test(a.name))
  if (arch === "arm64") return dmgs.find((a) => /-arm64\.dmg$/i.test(a.name)) ?? null
  return dmgs.find((a) => !/-arm64\.dmg$/i.test(a.name)) ?? null
}

// checksumFrom : l'empreinte SHA-256 d'un fichier, lue dans le tableau que la
// publication ajoute aux notes. Le tableau garde le nom d'origine, avec ses
// espaces ; le fichier de la release a des points à leur place.
export function checksumFrom(body: string | null | undefined, assetName: string): string | null {
  if (!body) return null
  const norme = (n: string) => n.replace(/[ .]/g, "")
  for (const ligne of body.split(/\r?\n/)) {
    const m = /^\|\s*`([^`]+)`\s*\|(?:[^|]*\|)?\s*`?([0-9a-f]{64})`?\s*\|/i.exec(ligne.trim())
    if (m && norme(m[1]) === norme(assetName)) return m[2].toLowerCase()
  }
  return null
}

// ---- la mise à jour en place ---------------------------------------------------
//
// Une application Electron, c'est deux choses : Electron lui-même (le moteur
// Chromium, ~120 Mo, qui ne change qu'avec lui) et notre code — `app.asar`, le
// moteur Zyvro, quelques icônes — qui change à chaque version. Chaque release
// publie donc aussi un **correctif** par machine : le dossier `Resources` seul,
// et l'`Info.plist` sur Mac. L'application le télécharge, l'applique sur
// elle-même une fois fermée, et se relance. Pas d'image à ouvrir, rien à
// glisser.
//
// Un correctif n'est valable que pour la même version d'Electron : les modules
// natifs (node-pty) sont compilés pour elle. Son nom la porte (`-e33.2.1`), et
// quand elle change on prend le paquet complet — le `.zip` sur Mac, remplacé
// en entier de la même façon ; l'installeur, sans questions, sous Windows.
//
// Et puisqu'un correctif contient tout notre code, pas une différence avec la
// version précédente, sauter trois versions ne coûte qu'un téléchargement.

export type PackageKind = "patch" | "full" | "manual"

const plateformeNom = (platform: string): string | null =>
  platform === "darwin" ? "mac" : platform === "win32" ? "win" : null

/**
 * Le nom du correctif, tel qu'écrit par `scripts/make-patch.mjs` et publié.
 *
 * `-app-e…` et plus `-patch-e…` depuis alpha.30 : les versions 24 à 29
 * cherchent `-patch-e…` et dépliaient mal un correctif (voir main/updater,
 * `fsBrut`). Ne le trouvant plus, elles prennent le paquet complet, qu'elles
 * savent poser — une seule fois, puis les correctifs reprennent.
 */
export function patchName(version: string, platform: string, arch: string, electron: string): string | null {
  const p = plateformeNom(platform)
  if (!p) return null
  return `Zyvro.Studio-${version.replace(/^v/, "")}-${p}-${arch}-app-e${electron}.tar.gz`
}

// pickUpdate : le paquet à télécharger, du plus léger au plus lourd.
//
// `inPlace` dit si l'application peut se réécrire là où elle est (un dossier
// où l'on peut écrire, pas une copie « translocalisée » par macOS). Sans ça,
// sur Mac, on retombe sur l'image disque à ouvrir soi-même.
export function pickUpdate(
  release: Release,
  platform: string,
  arch: string,
  electron: string,
  inPlace: boolean
): { kind: PackageKind; asset: ReleaseAsset } | null {
  const assets = release.assets
  if (inPlace) {
    const nom = patchName(release.tag_name, platform, arch, electron)
    const patch = nom ? assets.find((a) => a.name === nom) : undefined
    if (patch) return { kind: "patch", asset: patch }
    if (platform === "darwin") {
      const zips = assets.filter((a) => /-mac\.zip$/i.test(a.name))
      const zip = arch === "arm64" ? zips.find((a) => /-arm64-mac\.zip$/i.test(a.name)) : zips.find((a) => !/-arm64-mac\.zip$/i.test(a.name))
      if (zip) return { kind: "full", asset: zip }
    }
  }
  // L'installeur Windows se passe de questions (`/S`) et sait où il a été
  // installé : c'est un remplacement complet, pas un geste à faire.
  if (platform === "win32") {
    const exe = pickAsset(assets, platform, arch)
    return exe ? { kind: "full", asset: exe } : null
  }
  const dmg = pickAsset(assets, platform, arch)
  return dmg ? { kind: "manual", asset: dmg } : null
}
