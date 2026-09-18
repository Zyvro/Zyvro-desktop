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
