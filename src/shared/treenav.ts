// Se déplacer dans l'arbre de fichiers au clavier.
//
// Les règles de VS Code et du Finder, qu'on a dans les doigts : haut et bas
// passent d'une ligne à l'autre ; droite ouvre un dossier fermé, puis descend
// dans son premier enfant ; gauche referme un dossier ouvert, sinon remonte à
// son parent ; Entrée ouvre un fichier ou bascule un dossier.
//
// Pur, sur la liste à plat que l'arbre dessine déjà : pas de DOM, pas de
// React. `scripts/check-treenav.mjs` le vérifie ligne à ligne.

export type NavRow = { path: string; kind: "file" | "directory"; depth: number }

export type NavResult = {
  /** La ligne qui prend le focus, si elle change. */
  focus?: string
  expand?: string
  collapse?: string
  /** Un fichier à ouvrir. */
  open?: string
}

export function navigate(rows: NavRow[], focused: string | null, key: string, expanded: Set<string>): NavResult {
  if (rows.length === 0) return {}
  const i = focused === null ? -1 : rows.findIndex((r) => r.path === focused)
  // Sans focus, la première touche le pose sur la première ligne plutôt que
  // de sauter à la deuxième.
  if (i < 0) return { focus: rows[0].path }
  const row = rows[i]

  switch (key) {
    case "ArrowDown":
      return i + 1 < rows.length ? { focus: rows[i + 1].path } : {}
    case "ArrowUp":
      return i > 0 ? { focus: rows[i - 1].path } : {}
    case "Home":
      return { focus: rows[0].path }
    case "End":
      return { focus: rows[rows.length - 1].path }
    case "ArrowRight":
      if (row.kind !== "directory") return {}
      if (!expanded.has(row.path)) return { expand: row.path }
      // Ouvert : le premier enfant, s'il est déjà chargé et dessiné.
      return i + 1 < rows.length && rows[i + 1].depth > row.depth ? { focus: rows[i + 1].path } : {}
    case "ArrowLeft": {
      if (row.kind === "directory" && expanded.has(row.path)) return { collapse: row.path }
      for (let j = i - 1; j >= 0; j--) {
        if (rows[j].depth < row.depth) return { focus: rows[j].path }
      }
      return {}
    }
    case "Enter":
      if (row.kind === "file") return { open: row.path }
      return expanded.has(row.path) ? { collapse: row.path } : { expand: row.path }
    default:
      return {}
  }
}

// ancestorsOf : les dossiers à déplier pour qu'un chemin soit visible, de la
// racine vers lui. `src/app/page.tsx` → `src`, `src/app`.
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/")
  const out: string[] = []
  for (let k = 1; k < parts.length; k++) out.push(parts.slice(0, k).join("/"))
  return out
}

// scrollToShow : le défilement qui rend la ligne `index` visible, ou null
// quand elle l'est déjà. Juste assez, comme `scrollIntoView({ block:
// "nearest" })` — mais l'arbre est virtualisé, et la ligne qu'on vise n'existe
// peut-être pas encore dans le DOM.
export function scrollToShow(index: number, rowHeight: number, scrollTop: number, viewport: number): number | null {
  const top = index * rowHeight
  const bottom = top + rowHeight
  if (top < scrollTop) return top
  if (bottom > scrollTop + viewport) return Math.max(0, bottom - viewport)
  return null
}

// ---- la sélection multiple ---------------------------------------------------
//
// Les gestes du Finder et de VS Code : un clic choisit une ligne, ⌘-clic
// (Ctrl-clic ailleurs) en ajoute ou en retire une, ⇧-clic prend tout ce qui est
// entre la dernière choisie et celle-ci. Seul le clic simple ouvre : on ne
// veut pas que composer une sélection ouvre dix onglets.

export type Selection = { paths: Set<string>; anchor: string | null }

export function clickSelect(
  current: Selection,
  path: string,
  rows: { path: string }[],
  mods: { toggle: boolean; range: boolean }
): Selection & { act: boolean } {
  if (mods.range && current.anchor) {
    const a = rows.findIndex((r) => r.path === current.anchor)
    const b = rows.findIndex((r) => r.path === path)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      return { paths: new Set(rows.slice(lo, hi + 1).map((r) => r.path)), anchor: current.anchor, act: false }
    }
  }
  if (mods.toggle) {
    const paths = new Set(current.paths)
    if (paths.has(path)) paths.delete(path)
    else paths.add(path)
    return { paths, anchor: path, act: false }
  }
  return { paths: new Set([path]), anchor: path, act: true }
}

// dragged : ce qu'emporte une ligne qu'on attrape. Toute la sélection si elle
// en fait partie — c'est ce qu'on a composé pour ça — sinon elle seule, comme
// dans le Finder.
export function dragged(selection: Set<string>, path: string): string[] {
  return selection.has(path) && selection.size > 1 ? [...selection] : [path]
}

// ---- taper pour chercher ----------------------------------------------------
//
// Comme dans le Finder et l'arbre de VS Code : les lettres tapées à la suite
// (moins de `TYPE_AHEAD_MS` entre deux) sautent à la ligne dont le nom commence
// ainsi, sans distinguer la casse. Une même lettre répétée passe d'une ligne à
// la suivante qui commence par elle — `s`, `s`, `s` parcourt `src`, `scripts`,
// `styles.css`. On part de la ligne tenue : un mot qu'on continue de taper peut
// rester sur elle, une nouvelle recherche commence après elle, et le tour
// reprend en haut.

export const TYPE_AHEAD_MS = 800

export function typeAhead(rows: { path: string }[], focused: string | null, typed: string): string | null {
  if (rows.length === 0 || typed === "") return null
  const q = typed.toLowerCase()
  const repete = [...q].every((c) => c === q[0])
  const cherche = repete ? q[0] : q
  const i = focused === null ? -1 : rows.findIndex((r) => r.path === focused)
  // Un mot qui s'allonge peut rester sur la ligne tenue ; une lettre (ou la
  // même, répétée) passe à la suivante.
  const depart = repete ? i + 1 : Math.max(i, 0)
  for (let k = 0; k < rows.length; k++) {
    const row = rows[(depart + k) % rows.length]
    const nom = row.path.slice(row.path.lastIndexOf("/") + 1).toLowerCase()
    if (nom.startsWith(cherche)) return row.path
  }
  return null
}
