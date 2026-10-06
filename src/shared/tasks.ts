// La file de tâches d'un projet : ce qui doit partir à l'agent, dans l'ordre,
// à une heure dite, éventuellement chaque jour.
//
// La règle qui fait tout : une tâche ne part que quand l'agent est libre. Une
// tâche due pendant qu'un tour tourne attend la fin du tour, et la suivante
// attend la fin de celle-ci — une à la fois, dans l'ordre de la liste. C'est ce
// qui permet de lancer « relis les PR » à 9 h sans couper la conversation en
// cours, et d'empiler trois tâches sans qu'elles se marchent dessus.
//
// Tout ce qui décide (quand, laquelle, la suivante) est ici, sans horloge ni
// fichier, pour être vérifié par check-tasks.

export const TASKS_FILE = ".zyvro/tasks.json"

export const REPEATS = ["none", "hourly", "daily", "weekdays", "weekly"] as const
export type Repeat = (typeof REPEATS)[number]

export const REPEAT_LABELS: Record<Repeat, string> = {
  none: "Once",
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
}

export type TaskStatus = "done" | "failed" | "stopped"

export type ScheduledTask = {
  id: string
  title: string
  prompt: string
  /**
   * Quand elle part (ms epoch). Null : dès que l'agent est libre.
   * Pour une tâche récurrente, c'est la prochaine occurrence.
   */
  at: number | null
  repeat: Repeat
  /** Éteinte : gardée dans la liste, jamais lancée. Une tâche unique s'éteint en partant. */
  enabled: boolean
  /** « Run now » : part au prochain moment libre, avant les autres, sans toucher au rendez-vous. */
  runNow?: boolean
  lastRunAt?: number
  lastStatus?: TaskStatus
  runs: number
  createdAt: number
}

export type TaskFile = {
  /** La file entière en pause : rien ne part, rien n'est perdu. */
  paused: boolean
  tasks: ScheduledTask[]
}

export const EMPTY_TASKS: TaskFile = { paused: false, tasks: [] }

const HOUR = 3_600_000

/**
 * La prochaine occurrence strictement après `now`, à la même heure locale que
 * `at`. Null pour une tâche unique.
 *
 * Une échéance manquée (l'application était fermée) ne se rattrape qu'une
 * fois : on saute directement à la prochaine à venir, pas à toutes celles du
 * week-end.
 */
export function nextAfter(at: number, repeat: Repeat, now: number): number | null {
  if (repeat === "none") return null
  if (repeat === "hourly") {
    if (at > now) return at
    return at + Math.floor((now - at) / HOUR + 1) * HOUR
  }
  const d = new Date(at)
  const step = repeat === "weekly" ? 7 : 1
  // Par jours de calendrier et non par 24 h : un passage à l'heure d'été ne
  // décale pas « tous les jours à 9 h » à 10 h.
  for (let i = 0; i < 800 && (d.getTime() <= now || (repeat === "weekdays" && isWeekend(d))); i++) {
    d.setDate(d.getDate() + step)
  }
  return d.getTime()
}

function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

/** Une tâche peut-elle partir maintenant, si l'agent est libre ? */
export function isDue(task: ScheduledTask, now: number): boolean {
  if (task.runNow) return true
  if (!task.enabled) return false
  return task.at === null || task.at <= now
}

/**
 * La tâche à lancer, ou null. Les « Run now » d'abord, puis l'ordre de la
 * liste — c'est l'ordre que la personne a choisi en les rangeant.
 */
export function dueTask(file: TaskFile, now: number): ScheduledTask | null {
  if (file.paused) return null
  return file.tasks.find((t) => t.runNow) ?? file.tasks.find((t) => isDue(t, now)) ?? null
}

/**
 * La tâche telle qu'elle doit être écrite au moment où elle part.
 *
 * Écrite au départ et pas à l'arrivée : une application fermée en plein tour
 * ne relancera pas au démarrage une tâche unique qui avait déjà tourné, et une
 * tâche récurrente a déjà son prochain rendez-vous.
 */
export function started(task: ScheduledTask, now: number): ScheduledTask {
  const base = { ...task, runNow: false, lastRunAt: now, lastStatus: undefined, runs: task.runs + 1 }
  if (task.repeat === "none") return { ...base, enabled: false }
  // Un « Run now » avant l'heure garde le rendez-vous : lancer à la main la
  // tâche de 9 h à 8 h ne la supprime pas pour aujourd'hui.
  if (task.runNow && task.at !== null && task.at > now) return base
  return { ...base, at: nextAfter(task.at ?? now, task.repeat, now) }
}

/** Ce que dit la file à côté d'une tâche : la prochaine fois, ou son dernier passage. */
export function describeNext(task: ScheduledTask, now: number, paused: boolean): string {
  if (task.runNow) return "Next, as soon as the agent is free"
  if (!task.enabled) return task.lastRunAt ? "Done" : "Off"
  if (paused) return "Queue paused"
  if (task.at === null || task.at <= now) return "Waiting for the agent"
  return `Next: ${when(task.at, now)}`
}

export function when(at: number, now: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const today = new Date(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === today.toDateString()) return `today ${time}`
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`
}

/**
 * Le fichier relu, tel qu'il peut être en vrai : écrit à la main, d'une autre
 * version, à moitié. Ce qui ne ressemble pas à une tâche est laissé de côté
 * plutôt que de faire échouer la file entière.
 */
export function parseTasks(raw: unknown): TaskFile {
  if (!raw || typeof raw !== "object") return { ...EMPTY_TASKS, tasks: [] }
  const r = raw as Record<string, unknown>
  const tasks: ScheduledTask[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(r.tasks) ? r.tasks : []) {
    if (!item || typeof item !== "object") continue
    const t = item as Record<string, unknown>
    const id = typeof t.id === "string" && t.id ? t.id : null
    const prompt = typeof t.prompt === "string" ? t.prompt : ""
    if (!id || seen.has(id) || prompt.trim() === "") continue
    seen.add(id)
    const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
    tasks.push({
      id,
      title: typeof t.title === "string" && t.title.trim() ? t.title.trim().slice(0, 120) : titleOf(prompt),
      prompt,
      at: num(t.at) ?? null,
      repeat: REPEATS.includes(t.repeat as Repeat) ? (t.repeat as Repeat) : "none",
      enabled: t.enabled !== false,
      runNow: t.runNow === true || undefined,
      lastRunAt: num(t.lastRunAt),
      lastStatus: t.lastStatus === "done" || t.lastStatus === "failed" || t.lastStatus === "stopped" ? t.lastStatus : undefined,
      runs: num(t.runs) ?? 0,
      createdAt: num(t.createdAt) ?? 0,
    })
  }
  return { paused: r.paused === true, tasks }
}

export function titleOf(prompt: string): string {
  const line = prompt.trim().split("\n").find((l) => l.trim())?.trim().replace(/\s+/g, " ") ?? ""
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Task"
}
