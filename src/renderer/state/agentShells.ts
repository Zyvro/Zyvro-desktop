import { useSyncExternalStore } from "react"
import type { AgentShellRecord } from "../../shared/agentShell"

// Les sessions d'agent natif du projet, côté fenêtre.
//
// Le principal les garde sur le disque (main/agentShells). Ici, la dernière
// liste qu'il a rendue, lisible par n'importe quel composant : la liste de la
// barre latérale, et les onglets du terminal qui y cherchent leur nom.
//
// Un magasin de module lu par `useSyncExternalStore`, comme le reste de l'app :
// le principal dit quand la liste change (`agentShell.onChanged`), et il
// n'y a donc rien à sonder.

type Snapshot = { records: AgentShellRecord[]; live: ReadonlySet<string> }

const EMPTY: Snapshot = { records: [], live: new Set() }
let snapshot: Snapshot = EMPTY
// Tout ce qu'on a vu, tous projets confondus : un onglet garde son nom même si
// la liste affichée est celle d'un autre projet.
const seen = new Map<string, AgentShellRecord>()
const listeners = new Set<() => void>()

let version = 0

/** Change à chaque mise à jour : de quoi re-rendre un composant qui lit `recordOf`. */
export function agentShellsVersion(): number {
  return version
}

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

export function subscribeAgentShells(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAgentShells(): Snapshot {
  return snapshot
}

export function useAgentShells(): Snapshot {
  return useSyncExternalStore(subscribeAgentShells, getAgentShells, () => EMPTY)
}

export function recordOf(id: string): AgentShellRecord | undefined {
  return seen.get(id)
}

/** Retenir un enregistrement que le principal vient de rendre (ouverture). */
export function noteRecord(record: AgentShellRecord): void {
  seen.set(record.id, record)
  emit()
}

let inFlight: Promise<void> | null = null

/** Redemander la liste au principal. Les appels simultanés n'en font qu'un. */
export function refreshAgentShells(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = window.zyvro.agentShell
    .list()
    .then(({ records, live }) => {
      for (const record of records) seen.set(record.id, record)
      snapshot = { records, live: new Set(live) }
      emit()
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

// Le principal prévient quand une session s'ouvre, finit, ou apprend son
// identifiant : un abonnement à l'import, comme les menus.
if (typeof window !== "undefined" && window.zyvro?.agentShell) {
  window.zyvro.agentShell.onChanged(() => void refreshAgentShells())
}
