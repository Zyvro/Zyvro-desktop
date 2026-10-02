import { DEFAULT_PERMISSION, PERMISSIONS, type Permission } from "../../shared/permission"

// Ce que l'agent a le droit de faire, retenu une fois pour toutes.
//
// **Ni par conversation, ni par projet.** Les deux ont été essayés, dans cet
// ordre, et la même question les a départagés à chaque fois : « si je mets
// YOLO, est-ce que ça reste YOLO ? ». Par conversation, non — chaque nouvelle
// phrase revenait au défaut. Par projet, non plus — ouvrir un autre dossier le
// remettait, et on ne s'en apercevait qu'en lisant « permission refusée ».
//
// La bonne réponse est plus simple que les deux : ce niveau ne décrit pas un
// dossier, il décrit quelqu'un. C'est une façon de travailler — regarder venir,
// ou laisser faire — et elle ne change pas selon le dépôt qu'on ouvre. C'est
// donc une préférence de la personne, et elle vaut partout.
//
// **Sur cette machine, pas dans le projet.** `.zyvro/` est fait pour être
// commité : un « YOLO » écrit là s'appliquerait à qui clone le dépôt, sur une
// machine dont ce n'est pas le choix. Le réglage vit donc dans le stockage du
// navigateur de l'application, à côté de l'interrupteur de complétion, qui est
// du même genre : un confort propre à cette installation.
//
// Il survit au redémarrage, et c'est délibéré : « YOLO » retenu est un risque
// qu'on prend les yeux ouverts, parce que la barre de saisie affiche le niveau
// en permanence, en ambre, juste sous le curseur.

const KEY = "zyvro.permission"

// Ce que la version d'avant écrivait : une valeur par projet, sous
// `zyvro.permission:/chemin/du/projet`.
const LEGACY = `${KEY}:`

const listeners = new Set<() => void>()
// Le cache est ce qui rend la lecture stable : `useSyncExternalStore` appelle
// l'instantané à chaque rendu, et relire le stockage à chaque fois rendrait une
// valeur neuve à chaque appel.
let known: Permission | null = null

function clean(raw: unknown): Permission | null {
  return typeof raw === "string" && (PERMISSIONS as readonly string[]).includes(raw) ? (raw as Permission) : null
}

// forgetLegacy efface les valeurs par projet de la version d'avant.
//
// Effacées et non reprises, et c'est le sens qui compte : promouvoir un « YOLO »
// choisi pour un seul dossier en réglage valable partout serait élargir un
// droit que personne n'a élargi. Dans l'autre sens on ne perd qu'un réglage,
// et on le retrouve d'un clic sur une barre qui l'affiche en permanence.
function forgetLegacy(): void {
  try {
    const partis: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key && key.startsWith(LEGACY)) partis.push(key)
    }
    for (const key of partis) window.localStorage.removeItem(key)
  } catch {
    // Un stockage refusé n'a rien à oublier.
  }
}

export function permission(): Permission {
  if (known) return known
  let stored: Permission | null = null
  try {
    stored = clean(window.localStorage.getItem(KEY))
  } catch {
    // Un stockage refusé n'est pas une raison de perdre le panneau : on repart
    // du défaut, qui est le niveau le plus courant.
  }
  forgetLegacy()
  known = stored ?? DEFAULT_PERMISSION
  return known
}

export function setPermission(value: Permission): void {
  known = value
  try {
    window.localStorage.setItem(KEY, value)
  } catch {
    // Tant pis pour la mémoire : le réglage vaut pour cette session.
  }
  for (const listener of listeners) listener()
}

export function subscribePermission(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
