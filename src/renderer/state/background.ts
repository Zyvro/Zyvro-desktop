import type { BackgroundEnd, BackgroundTask } from "../../preload"

// Les tâches de fond de Claude, par conversation (main/agent.ts, « garer »).
//
// À part des conversations et pas dans leur état : elles vivent dans un
// processus, pas dans le fil — une conversation rouverte demain n'en a plus,
// et rien ici n'est donc enregistré.
//
// Demandé : « des signaux visuels et textuels pour suivre les background
// tasks ». Ce module les nourrit tous, depuis la même source : le bandeau de la
// conversation, le badge sur la ligne d'outil qui a lancé la tâche, le point
// sur l'onglet, la pastille de la barre d'état, et la notification système
// quand une tâche finit pendant qu'on regarde ailleurs.

export type BackgroundState = {
  /** Ce qui tourne, par conversation. */
  active: ReadonlyMap<string, BackgroundTask[]>
  /** Comment s'est terminée chaque tâche, par l'appel d'outil qui l'a lancée. */
  ended: ReadonlyMap<string, BackgroundEnd>
}

let courant: BackgroundState = { active: new Map(), ended: new Map() }
const listeners = new Set<() => void>()

export function subscribeBackground(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function backgroundState(): BackgroundState {
  return courant
}

/** Compatibilité : la carte des tâches actives, par conversation. */
export function backgroundTasks(): ReadonlyMap<string, BackgroundTask[]> {
  return courant.active
}

function changer(next: BackgroundState): void {
  courant = next
  for (const l of listeners) l()
}

export function setBackground(conversationId: string, tasks: BackgroundTask[]): void {
  const active = new Map(courant.active)
  if (tasks.length > 0) active.set(conversationId, tasks)
  else active.delete(conversationId)
  changer({ ...courant, active })
}

export function noteEnded(task: BackgroundEnd): void {
  if (!task.toolUseId) return
  const ended = new Map(courant.ended)
  ended.set(task.toolUseId, task)
  // Borné : une longue journée de serveurs relancés ne doit pas grossir sans fin.
  while (ended.size > 200) ended.delete(ended.keys().next().value as string)
  changer({ ...courant, ended })
}

/** Toutes conversations confondues, pour la barre d'état. */
export function totalBackground(state: BackgroundState): number {
  let n = 0
  for (const tasks of state.active.values()) n += tasks.length
  return n
}

/** La tâche lancée par cet appel d'outil, si elle tourne encore. */
export function runningFor(state: BackgroundState, toolUseId: string): BackgroundTask | null {
  for (const tasks of state.active.values()) {
    const found = tasks.find((t) => t.toolUseId === toolUseId)
    if (found) return found
  }
  return null
}

/** Les mots d'une fin, tels que la ligne d'outil et la notification les disent. */
export function endLabel(status: string): string {
  if (status === "completed") return "finished"
  if (status === "failed") return "failed"
  if (status === "killed" || status === "stopped") return "stopped"
  return status
}

// Le texte que le principal donne à la reprise après une tâche de fond
// (`backgroundWakeText`). Reconnu au texte plutôt que marqué dans le message :
// une conversation rouverte demain le relit tel quel, sans champ de plus à
// enregistrer.
export function isBackgroundWake(text: string): boolean {
  return /^(Background task finished: |A background task finished\.$)/.test(text)
}

if (typeof window !== "undefined" && window.zyvro) {
  window.zyvro.agent.onBackground(({ conversationId, tasks }) => setBackground(conversationId, tasks))
  window.zyvro.agent.onBackgroundEnded(({ task }) => {
    noteEnded(task)
    // Le signal pour qui regarde ailleurs : une notification du système, pas
    // quand Studio est au premier plan (le bandeau et le fil le disent déjà).
    if (typeof document !== "undefined" && !document.hasFocus() && typeof Notification !== "undefined") {
      try {
        new Notification(`Background task ${endLabel(task.status)}`, { body: task.description || task.summary, silent: false })
      } catch {
        // Pas de notifications sur ce système : le bandeau suffit.
      }
    }
  })
}
