import { create } from "zustand"
import { useWorkspace } from "~/state/workspace"
import { getSettings } from "~/state/settings"
import { pluginOn } from "../../shared/plugins"
import { dueTask, EMPTY_TASKS, started, titleOf, type Repeat, type ScheduledTask, type TaskFile, type TaskStatus } from "../../shared/tasks"

// La file de tâches du projet ouvert, et l'horloge qui la fait avancer.
//
// L'horloge vit ici, au niveau du module, et pas dans un composant : une tâche
// de 9 h doit partir que le panneau de l'agent soit affiché ou non. Elle ne
// lance rien elle-même — c'est le panneau de l'agent qui sait ce qu'est un
// tour ; il s'inscrit comme « runner » et dit quand il est libre.
//
// Une seule tâche à la fois, quel que soit le projet : elle part quand plus
// aucune conversation ne tourne, et la suivante attend qu'elle ait fini.

export type TaskRunner = {
  /** Aucune conversation du projet affiché ne tourne, aucune question n'attend. */
  idle: () => boolean
  /**
   * Où en est cette conversation : elle tourne, ou son dernier tour a fini
   * bien ou mal. `undefined` : elle n'existe plus.
   */
  status: (threadId: string) => "running" | "done" | "failed" | undefined
  /** La conversation affichée : celle où part une tâche qu'on y crée. */
  session: () => string | undefined
  /**
   * Lance la tâche dans une conversation existante — la sienne si elle est
   * encore là, sinon celle qu'on regarde — et rend son id.
   */
  run: (task: ScheduledTask, threadId: string | undefined) => string
}

type Running = { project: string; taskId: string; threadId: string }

type TasksState = {
  project: string | null
  file: TaskFile
  loaded: boolean
  running: Running | null
  /** L'heure du dernier passage de l'horloge, pour que la liste dise « dans 5 min » juste. */
  now: number
}

export const useTasks = create<TasksState>(() => ({
  project: null,
  file: EMPTY_TASKS,
  loaded: false,
  running: null,
  now: Date.now(),
}))

let runner: TaskRunner | null = null
/** La conversation de chaque tâche : une tâche récurrente reprend la sienne. */
const threadOfTask = new Map<string, string>()

const TICK_MS = 5_000
let horloge: ReturnType<typeof setInterval> | null = null

export function setTaskRunner(next: TaskRunner): void {
  runner = next
  install()
}

function install(): void {
  if (horloge || typeof window === "undefined" || !window.zyvro?.project) return
  horloge = setInterval(tickTasks, TICK_MS)
  // Sous Node (les vérifications), l'horloge ne doit pas garder le processus en vie.
  ;(horloge as unknown as { unref?: () => void }).unref?.()
  window.zyvro.project.onTasksChanged(({ project, file }) => {
    if (project === useTasks.getState().project) useTasks.setState({ file })
  })
  // Le projet affiché change : sa file se relit. Un abonnement au magasin, pas
  // un effet — ce dépôt n'en veut pas, et c'est le magasin qui sait quel
  // projet est ouvert.
  const load = (project: string | null) => {
    useTasks.setState({ project, file: EMPTY_TASKS, loaded: false })
    if (!project) return
    void window.zyvro.project
      .tasks(project)
      .then((file) => {
        if (useTasks.getState().project === project) useTasks.setState({ file, loaded: true })
      })
      .catch(() => {})
  }
  let current = useWorkspace.getState().project?.project ?? null
  load(current)
  useWorkspace.subscribe((ws) => {
    const project = ws.project?.project ?? null
    if (project === current) return
    current = project
    load(project)
  })
}

function save(file: TaskFile): void {
  const { project } = useTasks.getState()
  if (!project) return
  useTasks.setState({ file })
  void window.zyvro.project.saveTasks(project, file).catch(() => {})
  // Une modification peut rendre une tâche due tout de suite (« Run now ») :
  // on n'attend pas cinq secondes pour le voir.
  queueMicrotask(tickTasks)
}

function change(map: (tasks: ScheduledTask[]) => ScheduledTask[]): void {
  const { file } = useTasks.getState()
  save({ ...file, tasks: map(file.tasks) })
}

export function addTask(input: { title: string; prompt: string; at: number | null; repeat: Repeat }): void {
  const task: ScheduledTask = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: input.title.trim() || titleOf(input.prompt),
    prompt: input.prompt,
    at: input.at,
    repeat: input.at === null ? "none" : input.repeat,
    enabled: true,
    runs: 0,
    createdAt: Date.now(),
    // Dans la session où on l'a écrite, pas dans un onglet à elle : c'est la
    // suite de cette conversation, avec son contexte.
    thread: runner?.session(),
  }
  change((tasks) => [...tasks, task])
}

export function updateTask(id: string, patch: Partial<Pick<ScheduledTask, "title" | "prompt" | "at" | "repeat" | "enabled">>): void {
  change((tasks) =>
    tasks.map((t) => {
      if (t.id !== id) return t
      const next = { ...t, ...patch }
      if (patch.title !== undefined) next.title = patch.title.trim() || titleOf(next.prompt)
      if (next.at === null) next.repeat = "none"
      return next
    })
  )
}

export function removeTask(id: string): void {
  threadOfTask.delete(id)
  change((tasks) => tasks.filter((t) => t.id !== id))
}

export function moveTask(id: string, delta: -1 | 1): void {
  change((tasks) => {
    const i = tasks.findIndex((t) => t.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= tasks.length) return tasks
    const next = [...tasks]
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })
}

export function runTaskNow(id: string): void {
  change((tasks) => tasks.map((t) => (t.id === id ? { ...t, runNow: true } : t)))
}

export function setQueuePaused(paused: boolean): void {
  save({ ...useTasks.getState().file, paused })
}

/**
 * Le tour d'une conversation est fini. Si c'était celui d'une tâche, elle
 * l'apprend, et la suivante peut partir.
 */
export function taskTurnEnded(threadId: string, status: TaskStatus): void {
  const { running } = useTasks.getState()
  if (!running || running.threadId !== threadId) return
  finish(running, status)
}

function finish(running: Running, status: TaskStatus): void {
  useTasks.setState({ running: null })
  const mark = (file: TaskFile): TaskFile => ({
    ...file,
    tasks: file.tasks.map((t) => (t.id === running.taskId ? { ...t, lastStatus: status } : t)),
  })
  if (running.project === useTasks.getState().project) {
    save(mark(useTasks.getState().file))
    return
  }
  // Le projet a changé pendant le tour : on écrit dans le sien, pas dans celui
  // qui est affiché.
  void window.zyvro.project
    .tasks(running.project)
    .then((file) => window.zyvro.project.saveTasks(running.project, mark(file)))
    .catch(() => {})
  queueMicrotask(tickTasks)
}

/** Un passage de l'horloge, exporté pour check-tasks. */
export function tickTasks(): void {
  const s = useTasks.getState()
  const now = Date.now()
  useTasks.setState({ now })
  if (!runner || !s.loaded || !s.project) return
  // Le plugin « Task queue » éteint (shared/plugins) : rien ne part. Une tâche
  // déjà lancée finit son tour ; la reprise ci-dessous la clôt au rallumage
  // si personne ne l'a fait entre-temps.
  if (!pluginOn(getSettings().agent, "tasks")) return
  if (s.project !== (useWorkspace.getState().project?.project ?? null)) return

  if (s.running) {
    if (s.running.project !== s.project) return
    const status = runner.status(s.running.threadId)
    if (status === "running") return
    // La conversation ne tourne plus et personne ne l'a dit (un envoi refusé,
    // un onglet fermé, un tour libéré de force) : la tâche est finie, et la
    // file ne reste pas bloquée derrière.
    finish(s.running, status ?? "stopped")
    return
  }

  if (!runner.idle()) return
  const task = dueTask(s.file, now)
  if (!task) return
  const reprise = task.thread ?? threadOfTask.get(task.id)
  const threadId = runner.run(task, reprise && runner.status(reprise) !== undefined ? reprise : undefined)
  threadOfTask.set(task.id, threadId)
  useTasks.setState({ running: { project: s.project, taskId: task.id, threadId } })
  save({ ...s.file, tasks: s.file.tasks.map((t) => (t.id === task.id ? started(t, now) : t)) })
}
