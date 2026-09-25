// Ce que l'arbre regarde, et comment il apprend que ça a bougé.
//
// L'arbre lit un dossier à la fois et garde ce qu'il a lu. Un agent qui écrit
// un fichier, un `git checkout`, un `npm i` : rien n'apparaissait avant qu'on
// pense à cliquer sur « Refresh », et on n'y pense pas — un arbre de fichiers a
// l'air d'être à jour.
//
// Le principal surveille les dossiers que celui-ci lui nomme, et rend « ce
// dossier a changé », sans dire quoi. C'est suffisant : relire un dossier est
// déjà ce que fait la requête, et une liste de différences à appliquer à la
// main serait une seconde vérité à côté de celle qui marche.
//
// La version plutôt qu'une invalidation : le numéro entre dans la clé de la
// requête, donc un changement est une clé nouvelle, que react-query va chercher
// tout seul. Invalider demanderait le client de requêtes ici, c'est-à-dire un
// contexte React dans un magasin de module — et un `useEffect`, qui n'a pas
// cours dans ce dépôt.

import { useWorkspace } from "~/state/workspace"

let started = false
const versions = new Map<string, number>()
const listeners = new Set<() => void>()

// L'écoute est montée à la première demande, pas à l'import : ce module est
// chargé par le rendu du navigateur de test comme par celui de l'app, et
// s'abonner avant qu'un projet existe ne servirait à rien.
function start(): void {
  if (started) return
  started = true
  window.zyvro.files.onChanged(({ dir }) => {
    versions.set(dir, (versions.get(dir) ?? 0) + 1)
    for (const listener of listeners) listener()
  })
}

// Compté : l'arbre et les éditeurs ouverts surveillent parfois le même dossier,
// et replier un dossier dans l'arbre ne doit pas rendre sourd l'éditeur d'un
// fichier qui s'y trouve.
// Par projet : ouvrir un autre dossier remet la surveillance du principal à
// zéro, et un compte hérité de l'ancien ferait croire le nouveau déjà surveillé.
const tenus = new Map<string, number>()
const cle = (dir: string) => `${useWorkspace.getState().root ?? ""}\u0000${dir}`

export function watchDir(dir: string): void {
  start()
  const k = cle(dir)
  const n = tenus.get(k) ?? 0
  tenus.set(k, n + 1)
  if (n > 0) return
  // Un dossier qui disparaît entre le clic et la demande, un projet qui se
  // ferme : la surveillance est un confort, pas une opération dont l'échec
  // mérite une fenêtre.
  void window.zyvro.files.watch(dir).catch(() => {})
}

export function unwatchDir(dir: string): void {
  const k = cle(dir)
  const n = tenus.get(k) ?? 0
  if (n > 1) {
    tenus.set(k, n - 1)
    return
  }
  tenus.delete(k)
  void window.zyvro.files.unwatch(dir).catch(() => {})
}

// versionOf : combien de fois ce dossier a changé depuis l'ouverture.
export function versionOf(dir: string): number {
  return versions.get(dir) ?? 0
}

export function subscribeFiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
