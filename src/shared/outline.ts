// L'Outline : les symboles du fichier actif, comme la section de VS Code en bas
// de l'Explorateur — fonctions, classes, méthodes, types ; les titres d'un
// Markdown.
//
// Pur : transformer ce que donne TypeScript (son arbre de navigation) ou le
// texte d'un Markdown en une liste à plat, avec la profondeur de chacun, et
// dire lequel contient le curseur. `scripts/check-outline.mjs`.

export type OutlineItem = { name: string; kind: string; line: number; column: number; depth: number }

// Ce que TypeScript appelle `getNavigationTree` : un arbre, des positions en
// caractères depuis le début du fichier.
export type NavTree = { text: string; kind: string; spans: { start: number; length: number }[]; nameSpan?: { start: number }; childItems?: NavTree[] }

// Ce que VS Code ne montre pas non plus : les imports (des alias), et les
// nœuds sans nom que TypeScript invente pour les fonctions anonymes passées
// en argument.
const CACHES = new Set(["alias", "script", "module"])

export function fromNavigationTree(root: NavTree, positionOf: (offset: number) => { line: number; column: number }, maxItems = 2000): OutlineItem[] {
  const out: OutlineItem[] = []
  const visiter = (n: NavTree, depth: number): void => {
    if (out.length >= maxItems) return
    const montrer = !CACHES.has(n.kind) && n.text !== "<function>" && n.text !== "<class>" && !n.text.startsWith('"')
    if (montrer) {
      const p = positionOf(n.nameSpan?.start ?? n.spans[0]?.start ?? 0)
      out.push({ name: n.text, kind: n.kind, line: p.line, column: p.column, depth })
    }
    for (const c of n.childItems ?? []) visiter(c, montrer ? depth + 1 : depth)
  }
  // La racine est le fichier lui-même.
  for (const c of root.childItems ?? []) visiter(c, 0)
  return out.sort((a, b) => a.line - b.line || a.column - b.column)
}

// Les titres d'un Markdown (#, ##…), hors des blocs de code.
export function markdownOutline(text: string): OutlineItem[] {
  const out: OutlineItem[] = []
  let dansCode = false
  const lignes = text.split(/\r?\n/)
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i]
    if (/^\s*(```|~~~)/.test(l)) {
      dansCode = !dansCode
      continue
    }
    if (dansCode) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    if (m) out.push({ name: m[2], kind: "heading", line: i + 1, column: 1, depth: m[1].length - 1 })
  }
  return out
}

// itemAt : le symbole où se trouve le curseur — le dernier qui commence avant
// lui, le plus profond à égalité ; -1 avant le premier.
export function itemAt(items: OutlineItem[], line: number): number {
  let best = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].line <= line) best = i
    else break
  }
  return best
}
