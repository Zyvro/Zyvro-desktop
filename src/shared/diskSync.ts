// Un fichier ouvert qui change sur le disque.
//
// Dans un éditeur où un agent écrit, c'est l'ordinaire : `claude` modifie
// `app.ts` pendant qu'il est ouvert. L'onglet gardait l'ancien texte — et ⌘S
// l'écrivait par-dessus le travail de l'agent, sans un mot. VS Code fait ceci,
// et on fait pareil :
//
// - rien de modifié ici : l'onglet prend le nouveau texte, tout seul ;
// - des modifications ici : on n'y touche pas, et c'est l'enregistrement qui
//   demande — écraser ce qui est sur le disque, ou reprendre sa version.
//
// `base` : le texte du disque sur lequel l'onglet s'appuie — lu à l'ouverture,
// puis à chaque enregistrement ou rechargement. Pur, `scripts/check-disk-sync.mjs`.

export type DiskChange = "ignore" | "reload" | "adopt" | "conflict"

/** Le disque a bougé (`disk`) : que faire de l'onglet (`current`) ? */
export function onDiskChange(base: string, disk: string, current: string): DiskChange {
  if (disk === base) return "ignore" // nos propres enregistrements, un `touch`
  if (current === disk) return "adopt" // la même chose des deux côtés
  if (current === base) return "reload" // rien de modifié ici
  return "conflict" // des deux côtés : c'est l'enregistrement qui demandera
}

/** Au moment d'écrire : le disque est-il toujours celui qu'on a lu ? */
export function beforeSave(base: string, disk: string | null, current: string): "write" | "ask" {
  if (disk === null || disk === base || disk === current) return "write"
  return "ask"
}
