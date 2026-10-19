// « Un shell ordinaire de plus », demandé d'ailleurs que de la barre d'onglets
// (le bouton + de la barre latérale droite). Même mécanique que le split
// (`terminalSplit`) : un jeton que le panneau du terminal prend une fois.

let jeton = 0
const listeners = new Set<() => void>()

export function askOpenShell(): void {
  jeton++
  for (const l of listeners) l()
}
export const openShellToken = (): number => jeton
export function subscribeOpenShell(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
