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
const QUEUED_KEY = "zyvro.agentQueued"
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

function brouillonsStockes(): Map<string, string> {
  return new Map(
    Object.entries(lire<Record<string, unknown>>(DRAFTS_KEY, {})).filter(
      (e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""
    )
  )
}

const brouillons = brouillonsStockes()
const ecouteurs = new Set<() => void>()
let sauvegarde: ReturnType<typeof setTimeout> | null = null
// Les sessions dont le brouillon a changé ici depuis la dernière écriture.
// Plusieurs fenêtres partagent le stockage : chacune réécrivait TOUS les
// brouillons tels qu'elle les avait lus au lancement, et la dernière à
// enregistrer effaçait ceux des autres. On ne pose plus que les siens.
const modifies = new Set<string>()

function ecrireBrouillons(): void {
  const stockes = brouillonsStockes()
  for (const id of modifies) {
    // Retirer puis remettre : le plus récent passe à la fin, et c'est lui
    // qu'on garde quand on borne.
    stockes.delete(id)
    const texte = brouillons.get(id)
    if (texte) stockes.set(id, texte)
  }
  modifies.clear()
  ecrire(DRAFTS_KEY, Object.fromEntries([...stockes].slice(-DRAFTS_MAX)))
}

function prevenir(): void {
  for (const listener of ecouteurs) listener()
}

function sauverPlusTard(): void {
  // Une rafale de frappes n'écrit qu'une fois.
  if (sauvegarde) clearTimeout(sauvegarde)
  sauvegarde = setTimeout(() => {
    sauvegarde = null
    // Bornés aux plus récents : un brouillon de session supprimée ne doit pas
    // rester des mois dans le stockage.
    ecrireBrouillons()
  }, 250)
}

export function subscribeDrafts(listener: () => void): () => void {
  ecouteurs.add(listener)
  return () => ecouteurs.delete(listener)
}

export function draftFor(threadId: string): string {
  return brouillons.get(threadId) ?? ""
}

// ---------- la session neuve ----------
//
// Une session sans message n'a pas d'identifiant stable : le panneau en crée
// une nouvelle à chaque lancement, et son brouillon, rangé sous l'ancien
// identifiant, n'était plus retrouvé après un redémarrage. Il est donc AUSSI
// rangé sous une clé par dossier — `blank:<dossier>` — que la session neuve du
// même dossier reprend tant qu'on n'a pas touché à la sienne.

const touches = new Set<string>()

export function blankKey(root: string | null): string {
  return `blank:${root ?? ""}`
}

// La clé d'un dossier appartient à UNE session neuve à la fois — la première
// qui la demande. Partagée, elle mélangeait les sessions vierges d'un même
// dossier : la deuxième affichait le brouillon de la première, et en le
// vidant, l'effaçait pour les deux.
const proprietaires = new Map<string, string>()

/** Cette session neuve tient-elle la clé de son dossier ? La prend si personne
 *  ne l'a. Idempotent : demander deux fois rend la même réponse. */
export function holdsBlank(threadId: string, blank: string | null): boolean {
  if (blank === null) return false
  const tient = proprietaires.get(blank)
  if (tient === undefined) {
    proprietaires.set(blank, threadId)
    return true
  }
  return tient === threadId
}

/** La session a envoyé son premier message : la clé du dossier est libre pour
 *  la prochaine session neuve, et son contenu est vidé. */
export function releaseBlank(threadId: string, blank: string | null): void {
  if (blank === null || proprietaires.get(blank) !== threadId) return
  proprietaires.delete(blank)
  setDraftFor(blank, "")
}

/** Le brouillon à montrer : celui de la session, ou — pour la session neuve qui
 *  tient la clé de son dossier — celui d'avant le redémarrage, tant qu'elle
 *  n'a rien écrit elle-même. */
export function draftShown(threadId: string, blank: string | null): string {
  const propre = brouillons.get(threadId) ?? ""
  if (propre !== "" || touches.has(threadId) || !holdsBlank(threadId, blank)) return propre
  return brouillons.get(blank!) ?? ""
}

export function setDraftFor(threadId: string, text: string): void {
  touches.add(threadId)
  const borne = text.length > DRAFT_MAX ? text.slice(0, DRAFT_MAX) : text
  if ((brouillons.get(threadId) ?? "") === borne) return
  // Supprimer puis remettre : la Map garde l'ordre d'insertion, donc le plus
  // récemment touché est à la fin — c'est lui qu'on garde quand on borne.
  brouillons.delete(threadId)
  if (borne !== "") brouillons.set(threadId, borne)
  modifies.add(threadId)
  prevenir()
  sauverPlusTard()
}

/** Pour les vérifications : écrire tout de suite. */
export function flushDrafts(): void {
  if (sauvegarde) {
    clearTimeout(sauvegarde)
    sauvegarde = null
  }
  ecrireBrouillons()
}

// La sauvegarde attend 250 ms après la dernière frappe : fermer la fenêtre ou
// recharger dans cet intervalle perdait les derniers mots tapés. `pagehide`
// part à chaque déchargement, même quand `beforeunload` a été annulé puis
// accordé par la boîte « fichiers non enregistrés ».
//
// Et ce qu'une autre fenêtre écrit arrive ici par `storage` : ses brouillons
// et ses prompts deviennent visibles sans relancer — sauf les brouillons
// qu'on est soi-même en train de modifier.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (sauvegarde) flushDrafts()
  })
  window.addEventListener("storage", (event) => {
    if (event.key === HISTORY_KEY) historique = historiqueStocke()
    if (event.key !== DRAFTS_KEY) return
    const stockes = brouillonsStockes()
    let change = false
    for (const id of new Set([...brouillons.keys(), ...stockes.keys()])) {
      if (modifies.has(id)) continue
      const texte = stockes.get(id)
      if (texte === brouillons.get(id)) continue
      if (texte === undefined) brouillons.delete(id)
      else brouillons.set(id, texte)
      change = true
    }
    if (change) prevenir()
  })
}

// ---------- l'historique ----------

function historiqueStocke(): string[] {
  const brut = lire<unknown>(HISTORY_KEY, [])
  return Array.isArray(brut) ? brut.filter((p): p is string => typeof p === "string" && p !== "") : []
}

let historique: string[] = historiqueStocke()

export function promptHistory(): readonly string[] {
  return historique
}

/** Retenir un prompt envoyé. Deux fois de suite le même ne fait qu'une entrée. */
export function rememberPrompt(text: string): void {
  const propre = text.trim()
  if (!propre) return
  // Relu avant d'ajouter : une autre fenêtre a pu envoyer depuis, et la
  // réécriture effaçait ses prompts.
  historique = historiqueStocke()
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

/** Échap pendant la navigation : rendre ce qu'on écrivait avant de remonter. */
export function cancelHistory(threadId: string): string | null {
  const nav = navigations.get(threadId)
  if (!nav) return null
  navigations.delete(threadId)
  return nav.saved
}

/**
 * Une session fermée emporte son brouillon. Sans ça il restait dans le
 * stockage indéfiniment — y compris ce qu'on avait collé pour ne pas l'envoyer.
 */
export function forgetDraft(threadId: string): void {
  navigations.delete(threadId)
  touches.delete(threadId)
  keepQueued(threadId, [])
  if (!brouillons.has(threadId)) return
  brouillons.delete(threadId)
  modifies.add(threadId)
  prevenir()
  sauverPlusTard()
}

// ---------- la file d'attente ----------
//
// Ce qu'on envoie pendant qu'un tour tourne attend dans une file, en mémoire.
// Elle ne repart pas d'elle-même après un redémarrage, et c'est voulu — mais
// fermer ou recharger la fenêtre jetait aussi le texte de ces messages, que
// personne n'avait jamais envoyé. Leur texte est donc gardé ici, et rendu à la
// boîte de leur session au démarrage suivant, comme le fait « Stop ».

// Relu à chaque fois, comme l'historique : une autre fenêtre a pu écrire la
// file de ses propres sessions depuis.
function filesStockees(): Record<string, string[]> {
  const brut = lire<unknown>(QUEUED_KEY, {})
  return brut && typeof brut === "object" && !Array.isArray(brut) ? (brut as Record<string, string[]>) : {}
}

/** La file de cette session a changé : garder son texte, ou l'oublier si elle est vide. */
export function keepQueued(threadId: string, texts: readonly string[]): void {
  const gardes = texts.filter((t) => typeof t === "string" && t !== "")
  const files = filesStockees()
  if (gardes.length === 0 && !(threadId in files)) return
  if (gardes.length === 0) delete files[threadId]
  else files[threadId] = gardes
  ecrire(QUEUED_KEY, files)
}

/**
 * Au démarrage : ce qui attendait dans la file de cette session repasse dans
 * sa boîte, à la suite du brouillon — rien ne part sans qu'on appuie sur
 * Entrée. Rend vrai s'il y avait quelque chose.
 */
export function restoreQueued(threadId: string): boolean {
  const garde = filesStockees()[threadId]
  const rendus = Array.isArray(garde) ? garde.filter((t) => typeof t === "string" && t !== "") : []
  keepQueued(threadId, [])
  if (rendus.length === 0) return false
  setDraftFor(threadId, [draftFor(threadId), ...rendus].filter(Boolean).join("\n\n"))
  return true
}
