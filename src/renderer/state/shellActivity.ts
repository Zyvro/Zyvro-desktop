// Ce que les shells d'agent font, vu de l'extérieur : écrivent-ils encore ?
//
// La file de tâches a besoin de savoir qu'« un agent est libre ». Dans
// l'interface native d'un harnais il n'y a pas de tour à surveiller : on ne voit
// que la sortie. Un agent qui travaille écrit sans cesse (texte qui défile,
// indicateur qui tourne) ; un agent qui attend ne dit plus rien. « Silencieux
// depuis QUIET_MS » est donc la mesure de « libre » — approchée, et dite comme
// telle.
//
// Un abonnement de module aux données des terminaux, lu par les consommateurs :
// pas un effet, et rien ne tourne tant que personne ne demande.

/** Silence, en millisecondes, au bout duquel un agent compte pour libre. */
export const QUIET_MS = 6000
/** Un harnais qui vient de recevoir une tâche met un instant à réagir : pas libre avant. */
export const GRACE_MS = 4000

const lastData = new Map<string, number>()

if (typeof window !== "undefined" && window.zyvro?.terminal) {
  window.zyvro.terminal.onData(({ id }) => {
    lastData.set(id, Date.now())
  })
}

export function noteActivity(ptyId: string, at = Date.now()): void {
  lastData.set(ptyId, at)
}

/** Ce shell a-t-il écrit depuis moins de `ms` ? Un shell jamais vu est silencieux. */
export function wrote(ptyId: string, ms: number = QUIET_MS, now = Date.now()): boolean {
  const at = lastData.get(ptyId)
  return at !== undefined && now - at < ms
}

export function forgetActivity(ptyId: string): void {
  lastData.delete(ptyId)
}
