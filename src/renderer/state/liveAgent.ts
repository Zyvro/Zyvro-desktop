import type { AgentKind } from "../../shared/harness"

// L'agent natif qu'on a sous les yeux, pour ce qui veut lui parler d'ailleurs.
//
// Les plugins de la barre (mémoire du projet, plugins en paquets, skills
// avancés) ouvraient chacun un agent neuf pour leur demande. Dans un shell
// natif, ce qu'on attend est l'inverse : la demande part dans l'agent avec
// lequel on travaille déjà, comme si on l'avait tapée — c'est ce que fait déjà
// la file de tâches. Le panneau Shell sait quel agent a la main ; il s'inscrit
// ici, et les plugins demandent ici, sans dépendre du composant.

type Driver = {
  /** Coller ce texte dans l'agent vivant qui a la main, puis Entrée. Faux s'il n'y en a pas. */
  prompt: (text: string) => boolean
  /** Le harnais de cet agent, ou null. */
  kind: () => AgentKind | null
}

let driver: Driver = { prompt: () => false, kind: () => null }

export function setLiveAgentDriver(next: Driver): void {
  driver = next
}

export function promptLiveAgent(text: string): boolean {
  return text.trim() ? driver.prompt(text) : false
}

export function liveAgentKind(): AgentKind | null {
  return driver.kind()
}
