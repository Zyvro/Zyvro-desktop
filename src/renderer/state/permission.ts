import { DEFAULT_PERMISSION, PERMISSIONS, type Permission } from "../../shared/permission"

// Ce que l'agent a le droit de faire, retenu par projet.
//
// **Par projet, pas par conversation.** C'était d'abord un choix de
// conversation, et la question « si je mets YOLO, est-ce que ça reste YOLO ? »
// a montré ce que ça donnait : non, chaque nouvelle conversation revenait au
// défaut, et il fallait le remettre. On ne choisit pas ce qu'un agent a le
// droit de faire en fonction de la phrase qu'on tape, on le choisit en fonction
// du dossier dans lequel on travaille.
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

const listeners = new Set<() => void>()
// Le cache est ce qui rend la lecture stable : `useSyncExternalStore` appelle
// l'instantané à chaque rendu, et relire le stockage à chaque fois rendrait une
// valeur neuve à chaque appel.
const known = new Map<string, Permission>()

function slot(project: string | null): string {
  return `${KEY}:${project ?? ""}`
}

function clean(raw: unknown): Permission | null {
  return typeof raw === "string" && (PERMISSIONS as readonly string[]).includes(raw) ? (raw as Permission) : null
}

export function permissionFor(project: string | null): Permission {
  const key = slot(project)
  const cached = known.get(key)
  if (cached) return cached
  let stored: Permission | null = null
  try {
    stored = clean(window.localStorage.getItem(key))
  } catch {
    // Un stockage refusé n'est pas une raison de perdre le panneau : on repart
    // du défaut, qui est le niveau le plus courant.
  }
  const value = stored ?? DEFAULT_PERMISSION
  known.set(key, value)
  return value
}

export function setPermissionFor(project: string | null, value: Permission): void {
  known.set(slot(project), value)
  try {
    window.localStorage.setItem(slot(project), value)
  } catch {
    // Tant pis pour la mémoire : le réglage vaut pour cette session.
  }
  for (const listener of listeners) listener()
}

export function subscribePermission(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
