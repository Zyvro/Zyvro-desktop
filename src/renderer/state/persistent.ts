import type { AgentKind } from "../../shared/harness"

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

/**
 * Ce qu'on demande au panneau du bas d'ouvrir.
 *
 * Deux sortes, et il fallait les distinguer : une session persistante, dont on
 * n'est que le client — fermer l'onglet la détache — et un harnais lancé dans
 * son interface à lui, qu'on tue en fermant l'onglet. Le panneau les ouvre par
 * deux chemins différents ; ce qu'elles ont en commun est d'être demandées
 * d'ailleurs, et c'est ce que ce module transporte.
 *
 * Un seul jeton pour les deux, parce qu'il n'y a qu'une file d'une place : la
 * dernière demande est celle qu'on ouvre, et deux compteurs à surveiller dans
 * le panneau seraient deux chances d'en manquer une.
 */
export type Demande =
  | { sorte: "persistante"; label: string }
  | { sorte: "harnais"; harnais: AgentKind; model: string | null; conversation: string | null }
  | { sorte: "installation"; harnais: AgentKind }
  | { sorte: "connexion"; harnais: AgentKind }

let demande: Demande | null = null
let jeton = 0
const listeners = new Set<() => void>()

/** Ouvrir la session portant cette étiquette. Vide = une nouvelle, sans nom. */
export function askOpen(label: string): void {
  poser({ sorte: "persistante", label })
}

/**
 * Ouvrir ce harnais dans son interface à lui, avec ce modèle — et, quand on la
 * nomme, sur la conversation du panneau qu'il doit reprendre.
 */
export function askHarness(harnais: AgentKind, model: string | null, conversation: string | null = null): void {
  poser({ sorte: "harnais", harnais, model, conversation })
}

/** Installer ce harnais, dans un onglet du terminal qui montre ce que npm fait. */
export function askInstall(harnais: AgentKind): void {
  poser({ sorte: "installation", harnais })
}

export function askLogin(harnais: AgentKind): void {
  poser({ sorte: "connexion", harnais })
}

function poser(valeur: Demande): void {
  demande = valeur
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
export function takeOpen(): Demande | null {
  const valeur = demande
  demande = null
  return valeur
}

export function subscribeOpen(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Et l'autre sens : quand une session vient d'apparaître ou de disparaître.
//
// La liste de la barre latérale interrogeait `screen -ls` toutes les dix
// secondes, plus un délai de 1,2 s après un clic — une supposition sur le temps
// qu'il faut à une session pour exister. Signalé par Jeremy : « dès qu'on ouvre
// un shell persistant il doit apparaître dans la liste, et pareil s'il se
// ferme ». Le moment exact est connu de celui qui attache : c'est quand le
// principal a rendu la session. Il le dit ici, la liste l'apprend, et le
// sondage ne sert plus qu'à ce qui se passe hors de l'application — un `screen`
// lancé dans un terminal à côté.

let changes = 0
const changeListeners = new Set<() => void>()

/** Une session vient d'être attachée, créée, tuée, ou de finir. */
export function sessionsChanged(): void {
  changes++
  for (const listener of changeListeners) listener()
}

export function sessionsToken(): number {
  return changes
}

export function subscribeSessions(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}
