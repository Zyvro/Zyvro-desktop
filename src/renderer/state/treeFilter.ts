// Le filtre de l'arbre (⌥⌘F), hors du composant.
//
// Le menu peut le demander quand l'arbre n'est pas affiché : le panneau s'ouvre,
// l'arbre se monte, et c'est ici qu'il trouve le filtre déjà ouvert — rien à
// « consommer », donc rien à perdre entre deux rendus. Le jeton, lui, ne sert
// qu'à reprendre le focus quand le champ est déjà là.
//
// Retenu par projet : ouvrir un autre projet ne garde pas le mot du précédent.

type Filtre = { project: string; text: string } | null

let filtre: Filtre = null
let jeton = 0
const listeners = new Set<() => void>()
const prevenir = (): void => {
  for (const l of listeners) l()
}

export function subscribeTreeFilter(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const treeFilter = (): Filtre => filtre
export const treeFilterFocus = (): number => jeton

export function openTreeFilter(project: string): void {
  if (!filtre || filtre.project !== project) filtre = { project, text: "" }
  jeton++
  prevenir()
}
export function setTreeFilter(project: string, text: string): void {
  filtre = { project, text }
  prevenir()
}
export function closeTreeFilter(): void {
  filtre = null
  prevenir()
}
