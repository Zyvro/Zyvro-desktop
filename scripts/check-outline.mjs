// L'Outline : les symboles du fichier actif, en bas de l'Explorateur.
//
// Ce qui casse en silence ici :
//
// 1. **Les imports et les fonctions anonymes** en tête de liste : VS Code ne
//    les montre pas, et ils noient ce qu'on cherche.
// 2. **Un titre dans un bloc de code** pris pour un titre du Markdown.
// 3. **Le symbole du curseur** mal désigné.
//
//     node scripts/check-outline.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-outline-check")
mkdirSync(dir, { recursive: true })
await build({ entryPoints: [path.join(ROOT, "src/shared/outline.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Un arbre comme TypeScript le rend, avec des positions en caractères.
const texte = 'import x from "y"\nclass Panier {\n  ajouter() {}\n}\nfunction total() {\n  [1].map(() => 1)\n}\n'
const at = (s) => texte.indexOf(s)
const arbre = {
  text: '"file"', kind: "module", spans: [{ start: 0, length: texte.length }],
  childItems: [
    { text: "x", kind: "alias", spans: [{ start: at("x"), length: 1 }] },
    { text: "Panier", kind: "class", spans: [{ start: at("class"), length: 10 }], nameSpan: { start: at("Panier") },
      childItems: [{ text: "ajouter", kind: "method", spans: [{ start: at("ajouter"), length: 7 }] }] },
    { text: "total", kind: "function", spans: [{ start: at("function"), length: 10 }], nameSpan: { start: at("total") },
      childItems: [{ text: "<function>", kind: "function", spans: [{ start: at("() =>"), length: 5 }] }] },
  ],
}
const position = (o) => {
  const avant = texte.slice(0, o).split("\n")
  return { line: avant.length, column: avant[avant.length - 1].length + 1 }
}
const items = t.fromNavigationTree(arbre, position)
check(
  "**classes, méthodes, fonctions ; ni imports ni fonctions anonymes**",
  JSON.stringify(items.map((i) => [i.name, i.kind, i.line, i.depth])) === JSON.stringify([["Panier", "class", 2, 0], ["ajouter", "method", 3, 1], ["total", "function", 5, 0]]),
  JSON.stringify(items)
)
check("la position est celle du nom, pas du mot-clé", items[0].column === 7)
check("**le curseur dans une méthode la désigne**", t.itemAt(items, 3) === 1)
check("dans la fonction suivante, elle", t.itemAt(items, 6) === 2)
check("avant le premier symbole, aucun", t.itemAt(items, 1) === -1)

const md = t.markdownOutline("# Titre\ntexte\n## Partie\n```\n# pas un titre\n```\n### Détail ###\n")
check(
  "**Markdown : les titres, pas ceux des blocs de code**",
  JSON.stringify(md.map((i) => [i.name, i.line, i.depth])) === JSON.stringify([["Titre", 1, 0], ["Partie", 3, 1], ["Détail", 7, 2]]),
  JSON.stringify(md)
)

{
  const app = readFileSync(path.join(ROOT, "src/renderer/App.tsx"), "utf8")
  check("la section est dans l'Explorateur", /<OutlineList \/>/.test(app))
  const st = readFileSync(path.join(ROOT, "src/renderer/state/outline.ts"), "utf8")
  check("recalculée une demi-seconde après la frappe, pas à chaque touche", /plusTard\(path, 500\)/.test(st))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nL'Outline montre ce qu'on cherche, et où l'on est.")
