import fs from "node:fs/promises"
import path from "node:path"

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
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
  return out
}

export type FileRead = { path: string; text: string; truncated: boolean } | { path: string; binary: true }

export async function readFile(root: string, relative: string): Promise<FileRead> {
  const file = await resolveInside(root, relative)
  const stat = await fs.stat(file)
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

// deleteEntry removes a file or folder. The renderer is expected to confirm
// with the user first; this function does not second-guess it, but it does
// refuse to delete the project root itself.
export async function deleteEntry(root: string, relative: string): Promise<void> {
  const target = await resolveInside(root, relative)
  const rootReal = await fs.realpath(root)
  if (target === rootReal) throw new Error("Refused to delete the project root.")
  await fs.rm(target, { recursive: true, force: true })
}
