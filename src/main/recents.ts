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
  app.clearRecentDocuments()
  return []
}
