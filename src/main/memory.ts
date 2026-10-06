// La mémoire d'un projet, sur le disque : `ZYVRO.md` à la racine.
//
// Lue pour le panneau (avec son état : vide, à jour, vieillie) et pour chaque
// tour d'agent, qui la reçoit dans son préambule. Écrite quand on la corrige
// à la main depuis le panneau ; l'agent qui l'entretient l'écrit lui-même,
// avec ses propres outils.

import { promises as fs } from "node:fs"
import path from "node:path"
import { commitsSince } from "./git"
import { MEMORY_FILE, memoryState, type MemoryInfo } from "../shared/memory"

function memoryPath(root: string): string {
  return path.join(root, MEMORY_FILE)
}

async function readText(root: string): Promise<{ text: string; updatedAt: number } | null> {
  try {
    const file = memoryPath(root)
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)])
    return { text, updatedAt: stat.mtimeMs }
  } catch {
    return null
  }
}

export async function readMemory(root: string): Promise<MemoryInfo> {
  const found = await readText(root)
  const commits = found ? await commitsSince(root, found.updatedAt, MEMORY_FILE) : null
  return {
    state: memoryState({ text: found?.text ?? null, updatedAt: found?.updatedAt ?? null, commitsSince: commits, now: Date.now() }),
    path: memoryPath(root),
    text: found?.text ?? "",
    updatedAt: found?.updatedAt ?? null,
    commitsSince: commits,
  }
}

/** Ce que reçoit l'agent : le texte seul, sans passer par git — un tour ne doit pas attendre un `rev-list`. */
export async function memoryForAgent(root: string): Promise<string | null> {
  return (await readText(root))?.text ?? null
}

export async function writeMemory(root: string, text: string): Promise<MemoryInfo> {
  const target = memoryPath(root)
  const temp = `${target}.partial`
  await fs.writeFile(temp, text.endsWith("\n") || text === "" ? text : `${text}\n`)
  await fs.rename(temp, target)
  return readMemory(root)
}
