// La mémoire d'un projet, sur le disque : `ZYVRO.md` à la racine par défaut,
// ou le fichier choisi pour ce projet (CLAUDE.md, AGENTS.md, un doc…).
//
// Lue pour le panneau (avec son état : vide, à jour, vieillie) et pour chaque
// tour d'agent, qui la reçoit dans son préambule. Écrite quand on la corrige
// à la main depuis le panneau ; l'agent qui l'entretient l'écrit lui-même,
// avec ses propres outils.
//
// Le choix vit dans le dossier de l'application, pas dans le dépôt : c'est une
// préférence de la personne, et rien de Zyvro n'a à apparaître dans un commit.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"
import { commitsSince } from "./git"
import { resolveInside } from "./files"
import { MEMORY_FILE, MEMORY_SUGGESTIONS, memoryFileOk, memoryState, type MemoryInfo } from "../shared/memory"

// Où les choix sont gardés ; posé par le principal au démarrage. Sans lui (les
// contrôles), chaque projet garde ZYVRO.md.
let choicesFile: string | null = null

export function setMemoryChoicesFile(file: string): void {
  choicesFile = file
}

function choices(): Record<string, string> {
  if (!choicesFile) return {}
  try {
    const raw = JSON.parse(readFileSync(choicesFile, "utf8")) as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Le fichier de mémoire de ce projet, relatif à sa racine. */
export function memoryFileFor(root: string): string {
  const chosen = choices()[path.resolve(root)]
  return memoryFileOk(chosen) ? chosen.trim().replace(/\\/g, "/") : MEMORY_FILE
}

/** Choisir le fichier ; null revient à ZYVRO.md. Le chemin doit rester dans le projet. */
export async function setMemoryFile(root: string, relative: string | null): Promise<MemoryInfo> {
  if (relative !== null) {
    if (!memoryFileOk(relative)) throw new Error("Choose a file inside the project.")
    await resolveInside(root, relative)
  }
  if (!choicesFile) throw new Error("Memory settings are not available.")
  const all = choices()
  const key = path.resolve(root)
  const clean = relative?.trim().replace(/\\/g, "/") ?? null
  if (clean === null || clean === MEMORY_FILE) delete all[key]
  else all[key] = clean
  mkdirSync(path.dirname(choicesFile), { recursive: true })
  writeFileSync(choicesFile, JSON.stringify(all, null, 2), "utf8")
  return readMemory(root)
}

async function memoryPath(root: string): Promise<string> {
  // Revérifié à chaque lecture : un lien symbolique posé depuis ne doit pas
  // faire lire ni écrire hors du projet.
  return resolveInside(root, memoryFileFor(root))
}

async function readText(root: string): Promise<{ text: string; updatedAt: number } | null> {
  try {
    const file = await memoryPath(root)
    const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)])
    return { text, updatedAt: stat.mtimeMs }
  } catch {
    return null
  }
}

export async function readMemory(root: string): Promise<MemoryInfo> {
  const file = memoryFileFor(root)
  const found = await readText(root)
  const commits = found ? await commitsSince(root, found.updatedAt, file) : null
  return {
    state: memoryState({ text: found?.text ?? null, updatedAt: found?.updatedAt ?? null, commitsSince: commits, now: Date.now() }),
    path: path.join(root, file),
    text: found?.text ?? "",
    updatedAt: found?.updatedAt ?? null,
    commitsSince: commits,
    file,
    candidates: MEMORY_SUGGESTIONS.filter((name) => existsSync(path.join(root, name))),
  }
}

/** Ce que reçoit l'agent : le texte seul, sans passer par git — un tour ne doit pas attendre un `rev-list`. */
export async function memoryForAgent(root: string): Promise<string | null> {
  return (await readText(root))?.text ?? null
}

export async function writeMemory(root: string, text: string): Promise<MemoryInfo> {
  const target = await memoryPath(root)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.partial`
  await fs.writeFile(temp, text.endsWith("\n") || text === "" ? text : `${text}\n`)
  await fs.rename(temp, target)
  return readMemory(root)
}
