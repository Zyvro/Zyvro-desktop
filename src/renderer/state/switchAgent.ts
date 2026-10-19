// « Changer d'agent » : rouvrir la session d'un onglet avec un autre modèle, ou un
// autre harnais. Une demande que le panneau du terminal prend, comme les autres :
// l'enregistrement visé, et l'onglet qui l'affiche s'il y en a un.

type Request = { record: string } | null

let request: Request = null
const listeners = new Set<() => void>()

export function askSwitch(record: string): void {
  request = { record }
  for (const l of listeners) l()
}

export function closeSwitch(): void {
  request = null
  for (const l of listeners) l()
}

export const getSwitch = (): Request => request

export function subscribeSwitch(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
