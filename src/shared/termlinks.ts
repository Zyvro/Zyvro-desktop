// Les chemins de fichiers dans ce qu'écrit un terminal.
//
// Une erreur de compilation, une trace de pile, un test qui échoue : tous
// disent où regarder, et dans VS Code on clique dessus. Ici on recopiait le
// chemin dans ⌘P à la main. Les formes reconnues sont celles qu'on voit tous
// les jours :
//
//   src/app.ts:12:5          tsc --pretty, eslint, go, rustc, vite
//   src/app.ts(12,5)         tsc sans --pretty, MSBuild
//   File "app/main.py", line 12      Python
//   at fn (/abs/src/app.ts:12:5)     Node
//   ./src/app.ts             un chemin nu, avec son extension
//
// Pur. L'existence du fichier est vérifiée ailleurs, au principal : un texte
// qui ressemble à un chemin n'en est pas toujours un (`v1.2.3`, `e.g.`).
// `scripts/check-termlinks.mjs`.

export type PathLink = {
  /** Colonnes dans la ligne, fin exclue — ce que xterm veut souligner. */
  start: number
  end: number
  path: string
  /** Lignes et colonnes comptées à partir de 1, comme on les lit. */
  line: number | null
  column: number | null
}

// Un segment de chemin : lettres, chiffres, et la ponctuation des noms de
// fichiers courants. Pas d'espace, pas de deux-points — c'est ce qui sépare le
// chemin de sa ligne.
const SEG = "[\\w.@+\\-~]+"
// Un chemin : absolu (`/…`, `C:\…`), relatif (`./…`, `../…`) ou nu, avec au
// moins une extension au bout.
const CHEMIN = `(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?(?:${SEG}[\\\\/])*${SEG}\\.[A-Za-z0-9]{1,10}`

const FORMES: { re: RegExp; ligne: number; colonne: number }[] = [
  // "path", line 12 — Python
  { re: new RegExp(`"(${CHEMIN})", line (\\d+)`, "g"), ligne: 2, colonne: 0 },
  // path(12,5) ou path(12)
  { re: new RegExp(`(${CHEMIN})\\((\\d+)(?:,\\s?(\\d+))?\\)`, "g"), ligne: 2, colonne: 3 },
  // path:12:5 ou path:12, ou path seul
  { re: new RegExp(`(${CHEMIN})(?::(\\d+)(?::(\\d+))?)?`, "g"), ligne: 2, colonne: 3 },
]

// Les adresses web ont leur propre lien (WebLinksAddon) : ce qui en fait partie
// n'est pas un chemin de fichier.
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

export function findPathLinks(text: string): PathLink[] {
  const pris: [number, number][] = []
  for (const m of text.matchAll(URL_RE)) pris.push([m.index!, m.index! + m[0].length])
  const libre = (a: number, b: number) => pris.every(([x, y]) => b <= x || a >= y)

  const out: PathLink[] = []
  for (const forme of FORMES) {
    for (const m of text.matchAll(forme.re)) {
      const debut = m.index!
      const fin = debut + m[0].length
      if (!libre(debut, fin)) continue
      const chemin = m[1]
      // Le chemin commence là où il commence dans la correspondance : pour
      // Python, après le guillemet.
      const offset = m[0].indexOf(chemin)
      // Un nombre seul (`1.5`) ou une version (`v1.2.3`) n'est pas un fichier.
      if (/^v?\d+(\.\d+)+$/.test(chemin)) continue
      const ligne = forme.ligne && m[forme.ligne] ? Number(m[forme.ligne]) : null
      const colonne = forme.colonne && m[forme.colonne] ? Number(m[forme.colonne]) : null
      out.push({
        start: debut + offset,
        // Le lien couvre la ligne et la colonne quand elles suivent le chemin
        // directement, comme dans VS Code ; pas la fin de la phrase Python.
        end: forme.ligne === 2 && forme.colonne === 0 ? debut + offset + chemin.length : fin,
        path: chemin,
        line: ligne,
        column: colonne,
      })
      pris.push([debut, fin])
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// toProjectPath : le chemin d'un lien, vu depuis la racine du projet, ou null
// quand il n'y est pas. Relatif, il est compté depuis la racine — c'est là que
// s'ouvrent les shells de l'application. Les séparateurs sont ramenés à `/`.
export function toProjectPath(linkPath: string, root: string, platform: string): string | null {
  const p = linkPath.replace(/\\/g, "/")
  const absolu = p.startsWith("/") || /^[A-Za-z]:\//.test(p)
  if (!absolu) {
    const propre = p.replace(/^(\.\/)+/, "")
    if (propre.startsWith("../") || propre === "") return null
    return propre
  }
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const pareil = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (p.length <= base.length || !pareil(p.slice(0, base.length), base) || p[base.length] !== "/") return null
  return p.slice(base.length + 1)
}
