import { dialog, type BrowserWindow } from "electron"
import fs from "node:fs/promises"
import path from "node:path"

// Reading the workflows of a project that is not the one you have open.
//
// A workflow is a JSON file under `.zyvro/workflows/`, which is what makes this
// possible at all: the thing you want to copy is already a file, sitting in a
// folder, in whatever repository it belongs to. Copying one by hand means
// knowing that, finding it, and getting the name and the graph out — three
// steps that a button does better.
//
// Nothing is written here. This reads a folder and answers what it found; the
// current project's own daemon is what creates the copy, because it owns ids
// and slugs and would have to be told about the new file anyway.

export type ImportableWorkflow = {
  /** The id it has over there, kept only so the list has stable keys. */
  id: string
  name: string
  description: string
  /** The graph, as text, exactly as it was stored. */
  graphJSON: string
  /** How many nodes it has, which is the one thing worth showing in a list. */
  nodes: number
}

export type Importable = {
  project: string
  name: string
  workflows: ImportableWorkflow[]
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// countNodes is deliberately forgiving: a listing must not fail because one
// workflow in the other project is malformed. An unreadable graph shows as
// zero nodes rather than stopping the import of the four beside it.
function countNodes(graphJSON: string): number {
  try {
    const graph = JSON.parse(graphJSON) as { nodes?: unknown[] }
    return Array.isArray(graph.nodes) ? graph.nodes.length : 0
  } catch {
    return 0
  }
}

// read answers with what a folder holds, or an explanation of why it holds
// nothing. "Nothing found" and "that is not a Zyvro project" are different
// things to be told, and only one of them means you picked the wrong folder.
export async function read(projectDir: string): Promise<Importable> {
  const root = path.resolve(projectDir)
  const dir = path.join(root, ".zyvro", "workflows")

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    throw new Error(
      `"${path.basename(root)}" is not a Zyvro project: it has no .zyvro/workflows folder.`
    )
  }

  const workflows: ImportableWorkflow[] = []
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8")
      const stored = JSON.parse(raw) as Record<string, unknown>
      const graphJSON = str(stored.graph_json)
      if (!graphJSON) continue
      workflows.push({
        id: str(stored.id) || entry,
        name: str(stored.name) || entry.replace(/\.json$/, ""),
        description: str(stored.description),
        graphJSON,
        nodes: countNodes(graphJSON),
      })
    } catch {
      // One unreadable file is not a reason to refuse the others.
    }
  }

  return { project: root, name: path.basename(root), workflows }
}

// choose asks for a folder and reads it. The dialog is here rather than in the
// renderer because a renderer that could name a directory could name any
// directory; here, the person picks it themselves.
export async function choose(win: BrowserWindow): Promise<Importable | null> {
  const picked = await dialog.showOpenDialog(win, {
    title: "Import workflows from another project",
    properties: ["openDirectory"],
    buttonLabel: "Read this project",
  })
  if (picked.canceled || picked.filePaths.length === 0) return null
  return read(picked.filePaths[0])
}
