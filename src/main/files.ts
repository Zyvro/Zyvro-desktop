import fs from "node:fs/promises"
import path from "node:path"
import { shell } from "electron"
import { MAX_INLINE_BYTES, dataUri, kindOf } from "../shared/image"

// Everything the renderer can touch on disk goes through this module. The
// renderer runs untrusted-ish content (a workflow can render model output), so
// it never receives a raw fs handle: it names a path, and we check that path
// resolves inside the folder the user actually opened.

export type DirEntry = {
  name: string
  path: string // relative to the project root, POSIX separators
  kind: "file" | "directory"
}

// Folders that are noise in a project tree. Hiding them is not cosmetic: a
// node_modules expansion is tens of thousands of entries and would lock the UI.
export const HIDDEN = new Set([
  "node_modules",
  ".git",
  ".next",
  ".DS_Store",
  "out",
  "dist",
  "__pycache__",
  ".venv",
  "vendor",
])

const MAX_TEXT_BYTES = 2 * 1024 * 1024

export class PathOutsideProject extends Error {
  constructor(relative: string) {
    super(`Refused to access "${relative}": it is outside the open project.`)
  }
}

// resolveInside is the single gate. It rejects absolute paths, "..", and
// symlink escapes, so a crafted path from the renderer cannot read the user's
// SSH keys through a workflow that renders a filename.
export async function resolveInside(root: string, relative: string): Promise<string> {
  const rootReal = await fs.realpath(root)
  const target = path.resolve(rootReal, relative)
  const rel = path.relative(rootReal, target)
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new PathOutsideProject(relative)

  // A symlink inside the project can still point out of it, so check the real
  // path of the nearest existing ancestor too.
  let probe = target
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const realRel = path.relative(rootReal, real)
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new PathOutsideProject(relative)
      break
    } catch (err) {
      if (err instanceof PathOutsideProject) throw err
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return target
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/")
}

// Le comparateur, construit une fois.
//
// `a.localeCompare(b, undefined, { sensitivity: "base" })` en construit un
// NEUF à chaque comparaison. Sur un dossier de vingt-huit mille cinq cent
// soixante et une entrées, mesuré : 851 ms de tri contre 21 ms avec celui-ci,
// pour exactement le même ordre. Quarante fois, pour une ligne.
const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" })

export async function listDir(root: string, relative: string): Promise<DirEntry[]> {
  const dir = await resolveInside(root, relative || ".")
  // The listed paths must be relative to the *resolved* root, not the one the
  // user typed. On macOS /tmp is a symlink to /private/tmp, so measuring against
  // the unresolved root produced entries like "../../private/tmp/x/app.js" —
  // paths that the very gate which created them would then refuse.
  const rootReal = await fs.realpath(root)
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const out: DirEntry[] = []
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue
    out.push({
      name: entry.name,
      path: toRelative(rootReal, path.join(dir, entry.name)),
      kind: entry.isDirectory() ? "directory" : "file",
    })
  }
  // Directories first, then case-insensitive by name, which is what every
  // editor tree does and what the eye expects.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
    return COLLATOR.compare(a.name, b.name)
  })
  return out
}

export type FileRead =
  | { path: string; text: string; truncated: boolean }
  // Une image se regarde. C'est la troisième réponse possible, et elle manquait :
  // cliquer sur un `.png` dans l'arbre donnait « This file is binary or too
  // large to edit here », ce qui est vrai et inutile — on ne voulait pas
  // l'éditer, on voulait la voir.
  | { path: string; image: { mime: string; uri: string } }
  | { path: string; binary: true }

export async function readFile(root: string, relative: string): Promise<FileRead> {
  const file = await resolveInside(root, relative)
  const stat = await fs.stat(file)

  // L'image d'abord, et par ses octets plutôt que par son nom : une capture
  // sans extension est une image, `notes.png` qui contient du texte n'en est
  // pas, et c'est le contenu qui décide de ce qu'on affiche.
  //
  // Sa borne est la sienne : un PNG de trois mégaoctets ne s'édite pas mais se
  // regarde très bien, là où trois mégaoctets de texte dans un éditeur sont une
  // fenêtre qui rame.
  if (stat.size <= MAX_INLINE_BYTES) {
    const head = Buffer.alloc(Math.min(32, stat.size))
    const handle = await fs.open(file, "r")
    try {
      await handle.read(head, 0, head.length, 0)
    } finally {
      await handle.close()
    }
    const kind = kindOf(head)
    if (kind) {
      const bytes = await fs.readFile(file)
      return { path: relative, image: { mime: kind.mime, uri: dataUri(kind.mime, bytes) } }
    }
  }

  if (stat.size > MAX_TEXT_BYTES) return { path: relative, binary: true }
  const buffer = await fs.readFile(file)
  // A NUL byte in the first few KB is the pragmatic binary test every editor
  // uses; decoding an image as UTF-8 would fill the editor with replacement
  // characters and, if saved, destroy the file.
  if (buffer.subarray(0, 8000).includes(0)) return { path: relative, binary: true }
  return { path: relative, text: buffer.toString("utf8"), truncated: false }
}

export async function writeFile(root: string, relative: string, text: string): Promise<void> {
  const file = await resolveInside(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Write beside the target and rename: a crash mid-write would otherwise
  // leave the user with a truncated source file.
  const temp = `${file}.zyvro-tmp`
  await fs.writeFile(temp, text, "utf8")
  await fs.rename(temp, file)
}

export async function createEntry(
  root: string,
  relative: string,
  kind: "file" | "directory"
): Promise<void> {
  const target = await resolveInside(root, relative)
  if (kind === "directory") {
    await fs.mkdir(target, { recursive: true })
    return
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  // "wx" fails instead of truncating when the file already exists.
  const handle = await fs.open(target, "wx")
  await handle.close()
}

export async function renameEntry(root: string, from: string, to: string): Promise<void> {
  const source = await resolveInside(root, from)
  const target = await resolveInside(root, to)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(source, target)
}

// pasteEntry : coller ce qu'on a copié ou coupé, dans un dossier.
//
// Une seule fonction pour les deux gestes, parce que tout ce qui est délicat
// leur est commun — le portail, le nom libre, le dossier qu'on essaie de
// mettre dans lui-même — et que deux copies de ces règles, c'est une des deux
// qui oublie la troisième.
//
// **Rien n'est jamais écrasé.** C'est la décision qui compte ici. Coller par
// -dessus un fichier existant, c'est une perte qu'aucune corbeille ne rattrape :
// la corbeille garde ce qu'on supprime, pas ce qu'on remplace. Quand le nom est
// pris, on en choisit un libre — « notes 2.txt », « sprites 3 » — comme le
// Finder, et on rend le nom retenu pour que l'appelant puisse le montrer.
//
// Couper vers son propre dossier ne fait rien : ce n'est pas un doublon, c'est
// un geste sans effet, et fabriquer « notes 2.txt » pour ça surprendrait.
// Copier vers son propre dossier, en revanche, duplique — c'est ce qu'on veut
// dire en copiant-collant au même endroit.
export async function pasteEntry(
  root: string,
  from: string,
  intoDir: string,
  mode: "copy" | "move"
): Promise<string> {
  const source = await resolveInside(root, from)
  const destinationDir = await resolveInside(root, intoDir)

  const info = await fs.stat(source).catch(() => null)
  if (!info) throw new Error(`${from} is no longer there.`)

  const into = await fs.stat(destinationDir).catch(() => null)
  if (!into?.isDirectory()) throw new Error(`${intoDir || "the project root"} is not a folder.`)

  // Un dossier qu'on met dans lui-même, ou dans un de ses descendants : la
  // copie s'appellerait récursivement jusqu'au disque plein, et le déplacement
  // détacherait l'arbre de la racine. Les deux se refusent avant d'agir.
  if (info.isDirectory()) {
    const dedans = path.relative(source, destinationDir)
    if (dedans === "" || (!dedans.startsWith("..") && !path.isAbsolute(dedans))) {
      throw new Error(`A folder cannot be pasted into itself.`)
    }
  }

  // Couper vers le dossier qui le contient déjà : rien à faire.
  if (mode === "move" && path.dirname(source) === destinationDir) {
    return from
  }

  const target = await freeName(destinationDir, path.basename(source))
  if (mode === "move") {
    await fs.rename(source, target)
  } else {
    // `recursive` pour les dossiers ; `force: false` avec un nom déjà libre,
    // pour que le jour où `freeName` se trompe on ait une erreur plutôt qu'un
    // écrasement silencieux.
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true })
  }

  const rootReal = await fs.realpath(root)
  return path.relative(rootReal, target)
}

// freeName : un nom qui n'écrase personne, dans le goût du Finder.
//
// « notes.txt » pris devient « notes 2.txt », puis « notes 3.txt ». L'extension
// reste à la fin — « notes.txt 2 » se trierait mal et n'ouvrirait plus dans le
// bon programme — et un dossier n'a pas d'extension à préserver.
//
// La boucle est bornée : cent tentatives, et au-delà on le dit. Un dossier où
// cent noms sont pris est un dossier où quelque chose se passe qu'un
// cent-unième fichier n'arrangera pas.
async function freeName(dir: string, name: string): Promise<string> {
  const candidat = path.join(dir, name)
  if (!(await exists(candidat))) return candidat

  const ext = path.extname(name)
  const tige = ext ? name.slice(0, -ext.length) : name
  for (let n = 2; n < 100; n++) {
    const essai = path.join(dir, `${tige} ${n}${ext}`)
    if (!(await exists(essai))) return essai
  }
  throw new Error(`There are already too many copies of ${name} here.`)
}

async function exists(target: string): Promise<boolean> {
  // `lstat` et pas `stat` : un lien symbolique cassé occupe le nom tout de
  // même, et le prendre pour libre ferait échouer l'écriture juste après.
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false)
}

// deleteEntry met un fichier ou un dossier à la corbeille.
//
// À la corbeille et pas au néant, et c'est le changement qui compte : « Delete »
// dans un arbre de fichiers veut dire ce qu'il veut dire dans le Finder — on
// peut revenir. `fs.rm` d'un dossier récursif, sur un clic mal visé, c'est du
// travail perdu qu'aucune confirmation ne rattrape vraiment : on confirme ce
// qu'on croit avoir visé.
//
// Le rendu demande confirmation avant d'appeler ; cette fonction ne le refait
// pas, mais elle refuse toujours la racine du projet.
export async function deleteEntry(root: string, relative: string): Promise<void> {
  const target = await resolveInside(root, relative)
  const rootReal = await fs.realpath(root)
  if (target === rootReal) throw new Error("Refused to delete the project root.")
  // `trashItem` échoue là où il n'y a pas de corbeille — un volume réseau, un
  // conteneur. Mieux vaut alors le dire que supprimer pour de bon derrière le
  // dos de quelqu'un qui a lu « mettre à la corbeille ».
  await shell.trashItem(target)
}
