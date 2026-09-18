// Passer un texte à un panneau depuis un autre.
//
// « Ajouter à l'agent », « ouvrir dans le terminal » : dans les deux cas
// quelqu'un désigne un fichier dans l'arbre et le texte doit atterrir ailleurs.
// Le glisser-déposer faisait déjà exactement ça, mais il ne marche qu'entre
// deux endroits visibles en même temps, et un menu contextuel n'a pas cette
// contrainte.
//
// Un seul module pour les deux cibles plutôt qu'un canal par panneau : ce sont
// les mêmes trois lignes, et deux copies finiraient par différer sur le détail
// qui compte — celui de la consommation. Un texte remis doit être pris UNE
// fois : deux panneaux qui lisent la même boîte, ou un panneau qui relit après
// un rendu, et le chemin s'écrit deux fois dans la question.

export type Target = "agent" | "terminal"

const boites = new Map<Target, string>()
const listeners = new Map<Target, Set<() => void>>()
// Un jeton qui change à chaque remise. `useSyncExternalStore` compare ce que
// rend `getSnapshot` : rendre le texte lui-même ferait qu'une deuxième remise
// du même chemin passerait inaperçue.
const jetons = new Map<Target, number>()

function prevenir(target: Target): void {
  for (const listener of listeners.get(target) ?? []) listener()
}

// handTo remet un texte à un panneau. Il remplace ce qui n'a pas été pris : ce
// qui compte est le dernier geste, pas une file d'attente que personne ne
// regarde.
export function handTo(target: Target, text: string): void {
  if (!text) return
  boites.set(target, text)
  jetons.set(target, (jetons.get(target) ?? 0) + 1)
  prevenir(target)
}

export function subscribeHandoff(target: Target): (listener: () => void) => () => void {
  return (listener) => {
    const pour = listeners.get(target) ?? new Set()
    pour.add(listener)
    listeners.set(target, pour)
    return () => pour.delete(listener)
  }
}

// tokenOf est ce qu'un composant surveille. Il change à chaque remise, y
// compris pour deux fois le même texte.
export function tokenOf(target: Target): number {
  return jetons.get(target) ?? 0
}

// takeHandoff prend le texte et vide la boîte. Prendre, pas lire : appelé deux
// fois, le second appel ne rend rien, et c'est ce qui empêche un chemin de
// s'écrire deux fois dans la même question.
export function takeHandoff(target: Target): string | null {
  const texte = boites.get(target)
  if (texte === undefined) return null
  boites.delete(target)
  return texte
}
