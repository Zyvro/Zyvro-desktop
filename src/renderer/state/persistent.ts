// Ouvrir une session persistante depuis la barre latérale.
//
// La liste des sessions vit dans la barre ; les shells vivent dans le panneau
// du bas. Cliquer sur l'une doit ouvrir l'autre, et les deux ne sont pas le
// même composant — c'est exactement le cas de `handoff`, dont ce module reprend
// la mécanique : un jeton qui change à chaque demande, et une demande qui se
// prend UNE fois.
//
// Un module séparé plutôt qu'une quatrième cible dans `handoff` : ce qui
// voyage là-bas est un texte à écrire quelque part, ici c'est un ordre —
// « ouvre celle-ci ». Les faire passer par la même boîte demanderait de
// distinguer les deux à l'arrivée, et c'est le genre de distinction qu'on
// oublie un jour.

let demande: string | null = null
let jeton = 0
const listeners = new Set<() => void>()

/** Ouvrir la session portant cette étiquette. Vide = une nouvelle, sans nom. */
export function askOpen(label: string): void {
  demande = label
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
export function takeOpen(): string | null {
  const valeur = demande
  demande = null
  return valeur
}

export function subscribeOpen(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Et l'autre sens : quand une session vient d'apparaître ou de disparaître.
//
// La liste de la barre latérale interrogeait `screen -ls` toutes les dix
// secondes, plus un délai de 1,2 s après un clic — une supposition sur le temps
// qu'il faut à une session pour exister. Signalé par Jeremy : « dès qu'on ouvre
// un shell persistant il doit apparaître dans la liste, et pareil s'il se
// ferme ». Le moment exact est connu de celui qui attache : c'est quand le
// principal a rendu la session. Il le dit ici, la liste l'apprend, et le
// sondage ne sert plus qu'à ce qui se passe hors de l'application — un `screen`
// lancé dans un terminal à côté.

let changes = 0
const changeListeners = new Set<() => void>()

/** Une session vient d'être attachée, créée, tuée, ou de finir. */
export function sessionsChanged(): void {
  changes++
  for (const listener of changeListeners) listener()
}

export function sessionsToken(): number {
  return changes
}

export function subscribeSessions(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}
