// La recherche floue de Quick Open (⌘P).
//
// Ce qu'on attend d'elle, parce que c'est ce que VS Code a appris à tout le
// monde : taper `edarea` trouve `EditorArea.tsx`, taper `pan/term` trouve
// `panels/TerminalPanel.tsx`, et le fichier dont le *nom* correspond passe
// devant celui dont seul un dossier correspond.
//
// Les lettres de la requête doivent apparaître dans l'ordre, pas forcément
// côte à côte. Le score récompense ce que l'œil reconnaît : des lettres qui se
// suivent, un début de mot (après `/`, `.`, `-`, `_`, une espace, ou une
// majuscule au milieu d'un mot), et le nom du fichier plutôt que son chemin.
//
// Pur, pour se vérifier sans l'application : `scripts/check-fuzzy.mjs`.

export type FuzzyMatch = { score: number; positions: number[] }

const SEPARATEURS = new Set(["/", "\\", ".", "-", "_", " "])

function debutDeMot(texte: string, i: number): boolean {
  if (i === 0) return true
  const avant = texte[i - 1]
  if (SEPARATEURS.has(avant)) return true
  // camelCase : une majuscule après une minuscule.
  const c = texte[i]
  return c >= "A" && c <= "Z" && avant >= "a" && avant <= "z"
}

// matchIn cherche la requête dans `texte` à partir de `debut`, en préférant
// à chaque lettre un début de mot ou la suite immédiate de la précédente.
//
// Un glouton pur prendrait la première occurrence de chaque lettre : pour
// `ts` dans `tests/setup.ts` il accrocherait le `t` de `tests` et un `s` au
// hasard. On regarde donc devant : parmi les occurrences possibles de la
// lettre, celle qui commence un mot ou qui colle à la précédente gagne.
function matchIn(texte: string, bas: string, requete: string, debut: number): number[] | null {
  const positions: number[] = []
  let i = debut
  for (let q = 0; q < requete.length; q++) {
    const c = requete[q]
    let trouve = -1
    let premier = -1
    for (let j = i; j < bas.length; j++) {
      if (bas[j] !== c) continue
      if (premier < 0) premier = j
      const colle = positions.length > 0 && j === positions[positions.length - 1] + 1
      if (colle || debutDeMot(texte, j)) {
        trouve = j
        break
      }
    }
    if (trouve < 0) trouve = premier
    if (trouve < 0) return null
    positions.push(trouve)
    i = trouve + 1
  }
  return positions
}

function scoreOf(texte: string, positions: number[], nomDebut: number): number {
  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k]
    score += 1
    if (k > 0 && p === positions[k - 1] + 1) score += 5
    if (debutDeMot(texte, p)) score += 8
    if (p >= nomDebut) score += 4
  }
  // Un chemin court l'emporte à égalité : `app.ts` devant
  // `vendor/old/app.ts`.
  score -= texte.length * 0.05
  // Commencer le nom du fichier par la requête, c'est ce qu'on voulait dire.
  if (positions[0] === nomDebut) score += 10
  return score
}

// fuzzyMatch : null quand la requête n'apparaît pas dans l'ordre.
//
// Les espaces de la requête sont ignorées — on tape `edit area` en pensant à
// `EditorArea`. La casse aussi, sauf pour le score des débuts de mots, qui se
// lit sur le texte d'origine.
export function fuzzyMatch(query: string, path: string): FuzzyMatch | null {
  const requete = query.toLowerCase().replace(/\s+/g, "")
  if (requete === "") return { score: 0, positions: [] }
  const bas = path.toLowerCase()
  const nomDebut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1

  // Deux essais : dans le nom seul d'abord — c'est presque toujours ce qu'on
  // cherche — puis dans le chemin entier. Le meilleur des deux.
  const candidats: number[][] = []
  const dansLeNom = matchIn(path, bas, requete, nomDebut)
  if (dansLeNom) candidats.push(dansLeNom)
  const partout = matchIn(path, bas, requete, 0)
  if (partout) candidats.push(partout)
  if (candidats.length === 0) return null

  let meilleur: FuzzyMatch | null = null
  for (const positions of candidats) {
    const score = scoreOf(path, positions, nomDebut)
    if (!meilleur || score > meilleur.score) meilleur = { score, positions }
  }
  return meilleur
}

// rank : les `limit` meilleurs chemins pour une requête, du meilleur au moins
// bon. À score égal, l'ordre d'arrivée — les fichiers récents d'abord, si
// l'appelant les a mis devant.
export function rank(query: string, paths: string[], limit = 50): { path: string; positions: number[] }[] {
  const trouves: { path: string; positions: number[]; score: number; index: number }[] = []
  paths.forEach((path, index) => {
    const m = fuzzyMatch(query, path)
    if (m) trouves.push({ path, positions: m.positions, score: m.score, index })
  })
  trouves.sort((a, b) => b.score - a.score || a.index - b.index)
  return trouves.slice(0, limit).map(({ path, positions }) => ({ path, positions }))
}

// splitLine : `src/app.ts:42` ou `src/app.ts:42:7` → le chemin et l'endroit.
//
// C'est ce qu'on copie d'une trace d'erreur, et ce que VS Code accepte dans
// la même boîte. Lignes et colonnes comptées à partir de 1, comme partout où
// un humain les lit.
export function splitLine(query: string): { query: string; line: number | null; column: number | null } {
  const m = /^(.*?):(\d+)(?::(\d+))?\s*$/.exec(query)
  if (!m) return { query, line: null, column: null }
  return { query: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : null }
}
