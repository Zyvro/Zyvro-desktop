import { app } from "electron"
import fs from "node:fs"
import path from "node:path"

// Reopening yesterday's project is the single most common thing anyone does
// when they launch an editor, so the list of recent folders is persisted state,
// not session state. It lives in the app's own data directory rather than in
// any project, because it describes the user, not the code.

export type Recent = { path: string; name: string; openedAt: string }

const MAX = 12

function storeFile(): string {
  return path.join(app.getPath("userData"), "recent-projects.json")
}

export function loadRecents(): Recent[] {
  try {
    const raw = fs.readFileSync(storeFile(), "utf8")
    const parsed = JSON.parse(raw) as Recent[]
    if (!Array.isArray(parsed)) return []
    // A folder the user has since deleted or moved would be a dead menu entry,
    // so the list is filtered on every read rather than trusted.
    return parsed.filter((entry) => entry?.path && fs.existsSync(entry.path)).slice(0, MAX)
  } catch {
    return []
  }
}

function save(recents: Recent[]): void {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
    fs.writeFileSync(storeFile(), JSON.stringify(recents, null, 2), "utf8")
  } catch {
    // Losing the recent list is a cosmetic failure. It must never prevent a
    // project from opening, so this is deliberately swallowed.
  }
}

export function rememberRecent(dir: string): Recent[] {
  const entry: Recent = { path: dir, name: path.basename(dir), openedAt: new Date().toISOString() }
  const next = [entry, ...loadRecents().filter((r) => r.path !== dir)].slice(0, MAX)
  save(next)
  // The OS keeps its own recent list, which is what the dock icon's context
  // menu and the Finder's "Recent Items" read.
  app.addRecentDocument(dir)
  return next
}

export function forgetRecents(): Recent[] {
  save([])
  // « Clear Recently Opened » vide tout, fichiers compris, comme VS Code.
  forgetRecentFiles()
  app.clearRecentDocuments()
  return []
}

// ---- les fichiers récents -------------------------------------------------------
//
// Par projet, comme File › Open Recent de VS Code qui met les fichiers du
// dossier ouvert sous les dossiers : on ne veut pas les fichiers d'un autre
// projet dans celui-ci. Chemins relatifs au projet, le plus récent d'abord.

const MAX_FILES = 20
const MAX_PROJECTS = 30

function filesStore(): string {
  return path.join(app.getPath("userData"), "recent-files.json")
}

type FilesByProject = Record<string, string[]>

function loadAll(): FilesByProject {
  try {
    const parsed = JSON.parse(fs.readFileSync(filesStore(), "utf8")) as FilesByProject
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function saveAll(all: FilesByProject): void {
  try {
    fs.mkdirSync(path.dirname(filesStore()), { recursive: true })
    fs.writeFileSync(filesStore(), JSON.stringify(all, null, 2), "utf8")
  } catch {
    // Comme pour les projets : perdre la liste ne doit rien empêcher.
  }
}

// pushRecent : la liste avec `item` en tête, sans doublon, bornée. Pure.
export function pushRecent(list: string[], item: string, max: number): string[] {
  return [item, ...list.filter((x) => x !== item)].slice(0, max)
}

/** Les fichiers récents d'un projet, ceux qui existent encore. */
export function recentFiles(project: string): string[] {
  const list = loadAll()[project]
  if (!Array.isArray(list)) return []
  return list.filter((rel) => typeof rel === "string" && fs.existsSync(path.join(project, rel)))
}

/** Rend vrai quand la liste a changé — le menu est alors à refaire. */
export function rememberFile(project: string, rel: string): boolean {
  const all = loadAll()
  const avant = all[project] ?? []
  if (avant[0] === rel) return false
  // Le projet remonte en tête de l'objet : ce sont les plus anciens qu'on
  // oublie quand il y en a trop.
  const { [project]: _ancien, ...autres } = all
  const next: FilesByProject = { [project]: pushRecent(avant, rel, MAX_FILES), ...autres }
  for (const k of Object.keys(next).slice(MAX_PROJECTS)) delete next[k]
  saveAll(next)
  return true
}

export function forgetRecentFiles(): void {
  saveAll({})
}
