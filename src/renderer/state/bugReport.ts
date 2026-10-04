// Le bouton bug, côté fenêtre : combien d'erreurs depuis le dernier rapport,
// et les erreurs de la fenêtre elle-même, envoyées au journal du processus
// principal (main/bugreport.ts).

let unreported = 0
const listeners = new Set<() => void>()
let installed = false

function set(count: number): void {
  if (count === unreported) return
  unreported = count
  for (const listener of listeners) listener()
}

export function unreportedIncidents(): number {
  return unreported
}

export function subscribeIncidents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Une erreur vue ici, au journal. N'échoue jamais : un rapport d'erreur qui
 *  lève une erreur serait la pire des boucles. */
export function reportIncident(source: string, message: string): void {
  try {
    void window.zyvro?.bug.incident(source, message).catch(() => {})
  } catch {
    // Rien : le journal est un bonus, pas une condition.
  }
}

/** Une fois, au démarrage : les erreurs non rattrapées entrent au journal, et
 *  le compteur suit celui du processus principal. */
export function installIncidentCapture(): void {
  if (installed || typeof window === "undefined" || !window.zyvro?.bug) return
  installed = true
  window.addEventListener("error", (event) => {
    reportIncident("error", event.error instanceof Error ? event.error.stack ?? event.error.message : event.message)
  })
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason
    reportIncident("rejection", reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  })
  window.zyvro.bug.onIncidents(set)
  void window.zyvro.bug.unreported().then(set).catch(() => {})
}

/** Le rapport parti, le compteur repart de zéro sans attendre l'écho. */
export function markReported(): void {
  set(0)
}
