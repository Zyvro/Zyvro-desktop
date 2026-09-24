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
