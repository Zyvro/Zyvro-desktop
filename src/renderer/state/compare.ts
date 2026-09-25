// « Select for Compare », puis « Compare with Selected » : le fichier retenu
// entre les deux clics, comme dans VS Code. Un seul pour toute la fenêtre.

let retenu: string | null = null
const listeners = new Set<() => void>()

export function selectForCompare(path: string): void {
  retenu = path
  for (const l of listeners) l()
}
export const selectedForCompare = (): string | null => retenu
export function subscribeCompare(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
