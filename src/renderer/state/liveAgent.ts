import type { AgentKind } from "../../shared/harness"

// L'agent natif qu'on a sous les yeux, pour ce qui veut lui parler d'ailleurs.
//
// Les plugins de la barre (mémoire du projet, plugins en paquets, skills
// avancés) ouvraient chacun un agent neuf pour leur demande. Dans un shell
// natif, ce qu'on attend est l'inverse : la demande part dans l'agent avec
// lequel on travaille déjà, comme si on l'avait tapée — c'est ce que fait déjà
// la file de tâches. Le panneau Shell sait quel agent a la main ; il s'inscrit
// ici, et les plugins demandent ici, sans dépendre du composant.

/** Un agent précis, figé au moment où on l'a demandé. */
export type LiveAgent = {
  kind: AgentKind | null
  /** Coller ce texte dans CET agent, puis Entrée. Faux s'il n'est plus là. */
  prompt: (text: string) => boolean
}

type Driver = {
  /** L'agent vivant qui a la main, ou null. */
  current: () => LiveAgent | null
}

let driver: Driver = { current: () => null }

export function setLiveAgentDriver(next: Driver): void {
  driver = next
}

/**
 * L'agent qui a la main MAINTENANT. À garder plutôt qu'à redemander après une
 * attente : changer d'onglet pendant qu'un catalogue se charge ne doit pas
 * envoyer la suite à un autre agent que celui qu'on visait.
 */
export function liveAgent(): LiveAgent | null {
  return driver.current()
}

export function promptLiveAgent(text: string): boolean {
  if (!text.trim()) return false
  return driver.current()?.prompt(text) ?? false
}
