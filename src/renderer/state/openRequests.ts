import type { AgentKind } from "../../shared/harness"
import type { NativeSpec } from "../../shared/agentShell"

// Demander au panneau Shell d'ouvrir un onglet, depuis ailleurs : la barre
// latérale, le lanceur, la liste des sessions d'agent.
//
// Les demandes viennent d'autres composants que celui qui tient les shells.
// C'est la mécanique de `handoff` : un jeton qui change à chaque demande, et
// une demande qui se prend UNE fois.

/**
 * Ce qu'on demande au panneau Shell d'ouvrir. Un seul jeton pour toutes les
 * sortes : il n'y a qu'une file d'une place, la dernière demande est celle
 * qu'on ouvre.
 */
export type Demande =
  | { sorte: "harnais"; harnais: AgentKind; model: string | null; conversation: string | null }
  | { sorte: "installation"; harnais: AgentKind }
  | { sorte: "connexion"; harnais: AgentKind }
  // Un agent natif (shared/agentShell) : sa configuration et sa tâche, ou — avec
  // `spec.resume` — une session déjà enregistrée à rouvrir.
  | { sorte: "agent"; spec: NativeSpec; taskId?: string }

let demande: Demande | null = null
let jeton = 0
const listeners = new Set<() => void>()

/**
 * Ouvrir ce harnais dans son interface à lui, avec ce modèle — et, quand on la
 * nomme, sur la conversation du panneau qu'il doit reprendre.
 */
export function askHarness(harnais: AgentKind, model: string | null, conversation: string | null = null): void {
  poser({ sorte: "harnais", harnais, model, conversation })
}

/** Installer ce harnais, dans un onglet du terminal qui montre ce que npm fait. */
export function askInstall(harnais: AgentKind): void {
  poser({ sorte: "installation", harnais })
}

/** Lancer (ou reprendre) un agent natif dans un onglet du terminal. */
export function askAgent(spec: NativeSpec, taskId?: string): void {
  poser({ sorte: "agent", spec, taskId })
}

export function askLogin(harnais: AgentKind): void {
  poser({ sorte: "connexion", harnais })
}

function poser(valeur: Demande): void {
  demande = valeur
  jeton++
  for (const listener of listeners) listener()
}

export function openToken(): number {
  return jeton
}

/**
 * Prendre la demande. Prendre, pas lire : un deuxième rendu ne doit pas ouvrir
 * une seconde session.
 */
export function takeOpen(): Demande | null {
  const valeur = demande
  demande = null
  return valeur
}

export function subscribeOpen(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
