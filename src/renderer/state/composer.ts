// Ce qu'on écrit au panneau d'agent : le brouillon de chaque session, et
// l'historique de ce qu'on a envoyé.
//
// Demandé par Jeremy : « vérifier que même si j'ouvre / ferme des panneaux
// alors que j'ai déjà du texte dans un prompt, il ne soit pas perdu », et un
// historique des prompts. Le brouillon vivait dans un `useState` du panneau :
// fermer le panneau, passer en mode AI ou Dev, changer de session ou de projet
// démontait le composant, et ce qu'on écrivait partait avec. Il était aussi
// partagé entre toutes les sessions — commencé dans l'une, il apparaissait
// dans l'autre.
//
// Ici, hors de React : un brouillon par session, gardé en mémoire et dans le
// stockage de la fenêtre, donc qui survit aussi à un redémarrage. Et les
// derniers prompts envoyés, rappelés par ↑ et ↓ comme dans un terminal.

const DRAFTS_KEY = "zyvro.agentDrafts"
const HISTORY_KEY = "zyvro.promptHistory"
/** Les brouillons de cette taille-là sont des collages ; au-delà, on ne garde pas. */
const DRAFT_MAX = 100_000
const DRAFTS_MAX = 200
export const HISTORY_MAX = 200

function lire<T>(key: string, defaut: T): T {
  try {
    const brut = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null
    return brut ? (JSON.parse(brut) as T) : defaut
  } catch {
    return defaut
  }
}

function ecrire(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Plein ou refusé : le brouillon vaut pour cette session, c'est déjà ça.
  }
}

// ---------- les brouillons ----------

const brouillons = new Map<string, string>(
  Object.entries(lire<Record<string, unknown>>(DRAFTS_KEY, {})).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""
  )
)
const ecouteurs = new Set<() => void>()
let sauvegarde: ReturnType<typeof setTimeout> | null = null

function prevenir(): void {
  for (const listener of ecouteurs) listener()
}

function sauverPlusTard(): void {
  // Une rafale de frappes n'écrit qu'une fois.
  if (sauvegarde) clearTimeout(sauvegarde)
  sauvegarde = setTimeout(() => {
    sauvegarde = null
    // Les plus récents d'abord, bornés : un brouillon de session supprimée ne
    // doit pas rester des mois dans le stockage.
    const entrees = [...brouillons].slice(-DRAFTS_MAX)
    ecrire(DRAFTS_KEY, Object.fromEntries(entrees))
  }, 250)
}

export function subscribeDrafts(listener: () => void): () => void {
  ecouteurs.add(listener)
  return () => ecouteurs.delete(listener)
}

export function draftFor(threadId: string): string {
  return brouillons.get(threadId) ?? ""
}

export function setDraftFor(threadId: string, text: string): void {
  const borne = text.length > DRAFT_MAX ? text.slice(0, DRAFT_MAX) : text
  if ((brouillons.get(threadId) ?? "") === borne) return
  // Supprimer puis remettre : la Map garde l'ordre d'insertion, donc le plus
  // récemment touché est à la fin — c'est lui qu'on garde quand on borne.
  brouillons.delete(threadId)
  if (borne !== "") brouillons.set(threadId, borne)
  prevenir()
  sauverPlusTard()
}

/** Pour les vérifications : écrire tout de suite. */
export function flushDrafts(): void {
  if (sauvegarde) {
    clearTimeout(sauvegarde)
    sauvegarde = null
  }
  ecrire(DRAFTS_KEY, Object.fromEntries([...brouillons].slice(-DRAFTS_MAX)))
}

// ---------- l'historique ----------

let historique: string[] = lire<unknown[]>(HISTORY_KEY, []).filter((p): p is string => typeof p === "string" && p !== "")

export function promptHistory(): readonly string[] {
  return historique
}

/** Retenir un prompt envoyé. Deux fois de suite le même ne fait qu'une entrée. */
export function rememberPrompt(text: string): void {
  const propre = text.trim()
  if (!propre) return
  if (historique[historique.length - 1] === propre) return
  historique = [...historique.filter((p) => p !== propre), propre].slice(-HISTORY_MAX)
  ecrire(HISTORY_KEY, historique)
}

// La navigation, par session : où l'on en est dans l'historique, et ce qu'on
// était en train d'écrire avant de remonter — rendu quand on redescend au bout.
type Navigation = { index: number; saved: string }
const navigations = new Map<string, Navigation>()

/**
 * Remonter (`-1`) ou redescendre (`+1`) dans l'historique. Rend le texte à
 * mettre dans la boîte, ou null quand il n'y a nulle part où aller.
 */
export function stepHistory(threadId: string, direction: -1 | 1, current: string): string | null {
  const nav = navigations.get(threadId)
  if (direction === -1) {
    if (historique.length === 0) return null
    const index = nav ? nav.index - 1 : historique.length - 1
    if (index < 0) return null
    navigations.set(threadId, { index, saved: nav ? nav.saved : current })
    return historique[index]
  }
  if (!nav) return null
  const index = nav.index + 1
  if (index >= historique.length) {
    // Au bout : on rend ce qu'on écrivait avant de remonter.
    navigations.delete(threadId)
    return nav.saved
  }
  navigations.set(threadId, { index, saved: nav.saved })
  return historique[index]
}

/** On tape : on quitte la navigation, le texte est de nouveau le sien. */
export function leaveHistory(threadId: string): void {
  navigations.delete(threadId)
}

export function inHistory(threadId: string): boolean {
  return navigations.has(threadId)
}
