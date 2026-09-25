// Filtrer l'arbre en tapant (⌥⌘F de VS Code).
//
// « Taper pour chercher » saute à une ligne déjà dessinée ; filtrer répond à
// une autre question : où, dans tout le projet, y a-t-il un fichier qui
// s'appelle ainsi ? On part donc de la liste complète des fichiers (celle de
// ⌘P), on garde ceux dont le nom contient ce qu'on tape, et on redessine
// l'arbre avec eux seuls et les dossiers qui y mènent — tous ouverts, puisque
// c'est pour les voir qu'on filtre.
//
// Pur, sans DOM : `scripts/check-treefilter.mjs` le vérifie.

export type FilterEntry = { name: string; path: string; kind: "file" | "directory" }
export type FilterRow = { entry: FilterEntry; depth: number }

/** Au-delà, l'arbre filtré s'arrête : un mot d'une lettre dans un dépôt de
 *  cinquante mille fichiers ne doit pas en dessiner cinquante mille. */
export const FILTER_MAX = 2000

const COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" })

// matches : le nom contient ce qu'on tape, sans distinguer la casse. Avec un
// `/`, c'est le chemin qu'on regarde : `app/page` trouve `src/app/page.tsx`.
export function matches(path: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === "") return false
  const cible = q.includes("/") ? path : path.slice(path.lastIndexOf("/") + 1)
  return cible.toLowerCase().includes(q)
}

export function filterTree(
  files: string[],
  query: string
): { rows: FilterRow[]; matched: number; truncated: boolean } {
  const trouves: string[] = []
  let truncated = false
  for (const f of files) {
    if (!matches(f, query)) continue
    if (trouves.length >= FILTER_MAX) {
      truncated = true
      break
    }
    trouves.push(f)
  }

  // Les enfants de chaque dossier, "" pour la racine.
  const enfants = new Map<string, Map<string, FilterEntry>>()
  const ajouter = (parent: string, entry: FilterEntry): void => {
    let m = enfants.get(parent)
    if (!m) enfants.set(parent, (m = new Map()))
    if (!m.has(entry.path)) m.set(entry.path, entry)
  }
  for (const f of trouves) {
    const parts = f.split("/")
    for (let k = 1; k <= parts.length; k++) {
      const path = parts.slice(0, k).join("/")
      const parent = parts.slice(0, k - 1).join("/")
      ajouter(parent, { name: parts[k - 1], path, kind: k === parts.length ? "file" : "directory" })
    }
  }

  // Dans l'ordre de l'arbre : dossiers d'abord, puis par nom.
  const rows: FilterRow[] = []
  const derouler = (parent: string, depth: number): void => {
    const m = enfants.get(parent)
    if (!m) return
    const tries = [...m.values()].sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : COLLATOR.compare(a.name, b.name)
    )
    for (const entry of tries) {
      rows.push({ entry, depth })
      if (entry.kind === "directory") derouler(entry.path, depth + 1)
    }
  }
  derouler("", 0)
  return { rows, matched: trouves.length, truncated }
}
