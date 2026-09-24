// Ce qu'on lâche sur l'arbre de fichiers, et où ça va.
//
// Deux gestes, une seule règle de destination. Un fichier attrapé dans le
// Finder ou l'Explorateur Windows et lâché sur l'arbre est **copié** dans le
// projet — c'est ce que font VS Code et Cursor, et c'est le seul choix qui ne
// retire rien au dossier d'où il vient. Une ligne de l'arbre attrapée et lâchée
// sur un dossier de l'arbre est **déplacée** — ou copiée si l'on tient Alt
// (Option sur Mac), la même convention que le Finder.
//
// Pur, sans DOM ni `fs`, pour que les règles qui cassent en silence — un
// dossier qu'on met dans lui-même, un onglet qui garde l'ancien chemin — se
// vérifient sans lancer l'application : `scripts/check-treedrop.mjs`.

// ZYVRO_ENTRY : le type que l'arbre pose, en plus de `ZYVRO_PATH`, sur une
// ligne qu'on attrape. Le chemin *relatif* — c'est ce que parlent l'arbre et
// le principal — un par ligne.
//
// Un type à part plutôt que de relire `ZYVRO_PATH` : celui-ci est absolu, fait
// pour un shell ou un agent, et le retransformer en relatif demanderait de
// savoir d'où l'arbre compte — ce que ce module ne sait pas, et n'a pas à
// savoir.
export const ZYVRO_ENTRY = "application/x-zyvro-entry"

export type Target = { path: string; kind: "file" | "directory" }

// parentOf : le dossier qui contient un chemin relatif, "" pour la racine.
export function parentOf(relative: string): string {
  const i = relative.lastIndexOf("/")
  return i < 0 ? "" : relative.slice(0, i)
}

// dropFolder : dans quel dossier va ce qu'on lâche.
//
// Sur un dossier, dedans. Sur un fichier, à côté de lui — un fichier ne
// contient rien, et refuser le geste serait pire que de faire la chose
// évidente. Dans le vide sous la dernière ligne, à la racine.
export function dropFolder(target: Target | null): string {
  if (!target) return ""
  return target.kind === "directory" ? target.path : parentOf(target.path)
}

// isInside : `path` est `dir` lui-même ou quelque chose dedans.
//
// Par segments, pas par préfixe : `src` n'est pas dans `src-old`, et une
// comparaison de chaînes naïve dirait le contraire.
export function isInside(path: string, dir: string): boolean {
  if (dir === "") return true
  return path === dir || path.startsWith(`${dir}/`)
}

// canMove : ce déplacement a-t-il un sens.
//
// Non quand le dossier est mis dans lui-même ou dans un de ses descendants —
// le principal le refuserait aussi, mais le dire au survol, par l'absence de
// surbrillance, vaut mieux qu'une erreur après le lâcher. Non quand la
// destination est déjà son dossier : ce n'est pas un déplacement, et fabriquer
// « notes 2.txt » pour ça surprendrait.
export function canMove(from: string, into: string, mode: "copy" | "move"): boolean {
  if (from === "") return false
  if (isInside(into, from)) return false
  if (mode === "move" && parentOf(from) === into) return false
  return true
}

// retarget : ce que devient un chemin quand `from` a été déplacé vers `to`.
//
// Le chemin lui-même, ou quelque chose dedans quand c'est un dossier qui a
// bougé. Null quand il n'est pas concerné. C'est ce qui permet aux onglets
// ouverts de suivre un fichier renommé plutôt que de montrer « no longer
// there » à la prochaine sauvegarde — ou pire, de recréer l'ancien chemin en
// sauvegardant.
export function retarget(path: string, from: string, to: string): string | null {
  if (path === from) return to
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`
  return null
}

// entriesFromText lit ce que l'arbre a posé sous ZYVRO_ENTRY.
export function entriesFromText(text: string): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// topmost : ne garder que les chemins qui ne sont pas dans un autre.
//
// Déplacer `src` et `src/app.ts` ensemble, c'est déplacer `src` : le second
// geste échouerait, son fichier étant parti avec le premier.
export function topmost(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort()
  const out: string[] = []
  for (const p of unique) {
    if (!out.some((kept) => isInside(p, kept))) out.push(p)
  }
  return out
}

// relativeInside : un chemin absolu, vu depuis la racine du projet.
//
// Null quand il est dehors. Les séparateurs sont ramenés à `/` des deux côtés
// — le Finder et l'Explorateur Windows ne donnent pas les mêmes — et Windows
// compare sans la casse, parce que `C:\Projet` et `c:\projet` y sont le même
// dossier.
export function relativeInside(root: string, absolute: string, platform: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = norm(root)
  const cible = norm(absolute)
  const pareil = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (base === "" || cible.length <= base.length) return null
  if (!pareil(cible.slice(0, base.length), base) || cible[base.length] !== "/") return null
  return cible.slice(base.length + 1)
}
