// Go to Symbol in Workspace (⌘T) : les fonctions, classes, types… de tout le
// projet, pas seulement du fichier ouvert (⇧⌘O).
//
// Monaco n'expose pas la recherche de symboles de TypeScript (`navigateTo`).
// On la refait avec ce qu'il expose : l'arbre de navigation de chaque fichier
// indexé pour F12 (lib/projectIndex), mis à plat ici, puis trié en flou comme
// ⌘P. Comme VS Code, on garde les déclarations d'un fichier et les membres de
// ses classes, interfaces et énumérations — pas les variables locales d'une
// fonction, qui noieraient tout le reste.
//
// Pur : `scripts/check-workspace-symbols.mjs`.

import { fuzzyMatch } from "./fuzzy"
import type { NavTree } from "./outline"

export type WsSymbol = { name: string; kind: string; container: string; path: string; line: number; column: number }

// Des alias (les imports), le fichier lui-même, et les nœuds sans nom que
// TypeScript invente pour les fonctions anonymes.
const CACHES = new Set(["alias", "script", "module", "external module name"])
const CONTENANTS = new Set(["class", "interface", "enum", "type", "local class"])

export function symbolsFrom(path: string, root: NavTree, text: string, max = 400): WsSymbol[] {
  const debuts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) debuts.push(i + 1)
  const position = (offset: number): { line: number; column: number } => {
    let lo = 0
    let hi = debuts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (debuts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - debuts[lo] + 1 }
  }
  const out: WsSymbol[] = []
  const visiter = (n: NavTree, parent: NavTree | null): void => {
    if (out.length >= max) return
    const anonyme = n.text === "<function>" || n.text === "<class>" || n.text.startsWith('"') || n.text === "default"
    const montrer = !CACHES.has(n.kind) && !anonyme
    if (montrer) {
      const p = position(n.nameSpan?.start ?? n.spans[0]?.start ?? 0)
      out.push({ name: n.text, kind: n.kind, container: parent?.text ?? "", path, ...p })
    }
    // Les enfants d'une déclaration de haut niveau ne comptent que si elle en
    // est un contenant : les membres d'une classe, oui ; les variables d'une
    // fonction, non.
    if (montrer && !CONTENANTS.has(n.kind)) return
    for (const c of n.childItems ?? []) visiter(c, montrer ? n : parent)
  }
  for (const c of root.childItems ?? []) visiter(c, null)
  return out
}

// searchSymbols : les meilleurs pour une requête, sur le nom seul. À score
// égal, les déclarations de haut niveau passent devant les membres, puis le
// nom le plus court.
export function searchSymbols(
  symbols: WsSymbol[],
  query: string,
  limit = 60
): { symbol: WsSymbol; positions: number[] }[] {
  const q = query.trim()
  if (q === "") return []
  const trouves: { symbol: WsSymbol; positions: number[]; score: number }[] = []
  for (const s of symbols) {
    const m = fuzzyMatch(q, s.name)
    if (!m) continue
    // Le nom exact, puis un nom qui commence par la requête : ce qu'on voulait.
    const bas = s.name.toLowerCase()
    const ql = q.toLowerCase().replace(/\s+/g, "")
    const bonus = bas === ql ? 40 : bas.startsWith(ql) ? 15 : 0
    trouves.push({ symbol: s, positions: m.positions, score: m.score + bonus - (s.container ? 2 : 0) })
  }
  trouves.sort((a, b) => b.score - a.score || a.symbol.name.length - b.symbol.name.length || a.symbol.path.localeCompare(b.symbol.path))
  return trouves.slice(0, limit).map(({ symbol, positions }) => ({ symbol, positions }))
}
