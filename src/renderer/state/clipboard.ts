// Ce qu'on a coupé ou copié dans l'arbre, en attendant de le coller.
//
// Un magasin de module, comme la boîte de `handoff` : le geste commence dans un
// menu contextuel et se termine dans un autre, parfois sur une autre ligne, et
// les deux menus ne sont pas le même composant. Un état de React vivrait dans
// celui qui se ferme.
//
// **Ce n'est pas le presse-papiers du système, et c'est voulu.** Y écrire des
// chemins de fichiers pour que le Finder les comprenne demande un format
// propriétaire par plateforme (`NSFilenamesPboardType` chez Apple), et surtout
// ça écraserait ce que quelqu'un vient de copier ailleurs — un mot de passe, un
// bout de code. Couper un fichier dans l'arbre ne doit pas vider le
// presse-papiers de la personne. Celui-ci est donc à l'application, et ce
// qu'elle colle vient forcément de ce qu'elle a copié.

export type Held = {
  /** Le chemin, relatif à la racine du projet. */
  path: string
  /** Le nom, pour l'écrire dans le menu : « Paste “notes.txt” ». */
  name: string
  mode: "copy" | "move"
}

let held: Held | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function hold(entry: { path: string; name: string }, mode: "copy" | "move"): void {
  held = { path: entry.path, name: entry.name, mode }
  notify()
}

/**
 * Ce qui est retenu, ou null.
 *
 * Lu, pas pris : contrairement à la boîte de `handoff`, un copier se colle
 * plusieurs fois — c'est tout l'intérêt. C'est le couper qui ne vaut qu'une
 * fois, et c'est `released` qui s'en charge, après coup.
 */
export function heldItem(): Held | null {
  return held
}

/**
 * Le collage a eu lieu. Un « couper » se vide — le fichier n'est plus là où il
 * était, et le recoller déplacerait un chemin qui n'existe plus. Un « copier »
 * reste : on colle souvent dans deux endroits.
 */
export function released(): void {
  if (held?.mode !== "move") return
  held = null
  notify()
}

/** Oublier, sans coller. */
export function clearHeld(): void {
  if (held === null) return
  held = null
  notify()
}

export function subscribeClipboard(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
