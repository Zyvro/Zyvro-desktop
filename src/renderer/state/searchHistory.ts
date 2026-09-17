// Les recherches précédentes.
//
// On cherche deux fois la même chose dans la journée, et la seconde fois on la
// retape. C'est une frappe de trop par recherche, et c'est surtout celle qu'on
// rate : une expression régulière qu'on a mis une minute à écrire disparaît
// quand on efface le champ.
//
// Par projet, parce que les mots qu'on cherche sont ceux du dépôt qu'on a
// ouvert ; sur cette machine, comme le reste des confort de l'application, et
// pas dans `.zyvro/` qui est fait pour être commité.

const KEY = "zyvro.search.history"

// Vingt : au-delà, on ne remonte plus une liste, on cherche dedans — et
// chercher dans son historique de recherche est une plaisanterie qu'on ne fera
// pas.
const KEPT = 20

const listeners = new Set<() => void>()
const known = new Map<string, string[]>()

function slot(project: string | null): string {
  return `${KEY}:${project ?? ""}`
}

export function history(project: string | null): string[] {
  const key = slot(project)
  const cached = known.get(key)
  if (cached) return cached
  let stored: string[] = []
  try {
    const raw = window.localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) stored = parsed.filter((v): v is string => typeof v === "string").slice(0, KEPT)
  } catch {
    // Un stockage refusé ou un contenu abîmé : on repart sans historique, ce
    // qui est exactement l'état d'avant cette fonctionnalité.
  }
  known.set(key, stored)
  return stored
}

// remember n'est pas appelé à chaque frappe.
//
// Une recherche qui se déclenche après un silence en produirait une par
// préfixe — « w », « wo », « wor »… — et l'historique ne contiendrait que des
// moitiés de mots. On retient ce que la personne a validé.
export function remember(project: string | null, query: string): void {
  const value = query.trim()
  if (value === "") return
  const next = [value, ...history(project).filter((q) => q !== value)].slice(0, KEPT)
  known.set(slot(project), next)
  try {
    window.localStorage.setItem(slot(project), JSON.stringify(next))
  } catch {
    // Tant pis pour la mémoire : la liste vaut pour cette session.
  }
  for (const listener of listeners) listener()
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
