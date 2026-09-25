// « Split Terminal », demandé depuis le menu : un jeton que le panneau du
// terminal prend une fois, comme les autres demandes (voir `handoff`).

let jeton = 0
const listeners = new Set<() => void>()

export function requestTerminalSplit(): void {
  jeton++
  for (const l of listeners) l()
}
export const splitToken = (): number => jeton
export function subscribeSplit(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
