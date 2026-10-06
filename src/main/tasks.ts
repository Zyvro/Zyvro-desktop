// La file de tâches d'un projet, sur le disque : `.zyvro/tasks.json`.
//
// Dans le projet, comme son icône : la file appartient au projet, et la
// retrouver après un redémarrage — ou sur une autre machine — est le but d'une
// tâche planifiée. Écrite d'un coup (fichier partiel puis renommage) : une
// coupure au milieu ne laisse pas une file à moitié lisible.

import { promises as fs } from "node:fs"
import path from "node:path"
import { parseTasks, TASKS_FILE, type TaskFile } from "../shared/tasks"

function tasksPath(root: string): string {
  return path.join(root, ...TASKS_FILE.split("/"))
}

export async function readTasks(root: string): Promise<TaskFile> {
  try {
    return parseTasks(JSON.parse(await fs.readFile(tasksPath(root), "utf8")))
  } catch {
    return parseTasks(null)
  }
}

/** Écrit la file telle qu'elle est relue : ce qui ne passe pas `parseTasks` n'est pas écrit. */
export async function writeTasks(root: string, file: unknown): Promise<TaskFile> {
  const clean = parseTasks(file)
  const target = tasksPath(root)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.partial`
  await fs.writeFile(temp, `${JSON.stringify(clean, null, 2)}\n`)
  await fs.rename(temp, target)
  return clean
}
