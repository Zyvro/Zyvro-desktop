// L'aperçu Markdown lit un document, pas une réponse de modèle (shared/mdoc).
//
// Ce qui casse en silence ici :
//
// 1. **Les ancres.** `[voir](#installation)` doit viser l'id que GitHub donne
//    au titre, et deux titres pareils ne partagent pas le même.
//
// 2. **Les listes.** Imbriquées, avec des cases à cocher, et une ligne vide
//    entre deux éléments ne coupe pas la liste en deux.
//
// 3. **Les liens et les images relatifs.** Relatifs au dossier du document ;
//    `/` part de la racine ; rien ne sort du projet ; les références
//    (`[badge][ci]`) sont suivies.
//
// 4. **Le HTML d'un README.** Le logo en `<img>` se voit ; aucune balise
//    n'arrive jusqu'à la fenêtre.
//
// 5. **L'emphase.** `snake_case_name` n'est pas de l'italique.
//
//     node scripts/check-mdoc.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-mdoc-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/shared/mdoc").replace(/\\/g, "/")}"\n`)
await build({ entryPoints: [path.join(dir, "h.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", absWorkingDir: ROOT, logLevel: "silent" })
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const j = JSON.stringify
const kinds = (bs) => bs.map((b) => b.t)

const readme = `<p align="center"><img src="docs/logo.png" alt="Logo" width="120"></p>

# Zyvro Studio

[![CI][ci-badge]][ci] A **desktop** app.

## Install

1. Download
2. Open

   Then drag it.

- [x] done
- [ ] todo
  - nested

## Install

| Name | Size |
|:-----|-----:|
| a \\| b | \`1|2\` |

> quoted
lazy

Title
=====

\`\`\`ts
const x = 1
\`\`\`

---

[ci-badge]: https://example.com/badge.svg
[ci]: https://example.com/ci "CI"
`
const d = t.parseDoc(readme)
check("les blocs d'un README", j(kinds(d.blocks)) === j(["html", "heading", "para", "heading", "list", "list", "heading", "table", "quote", "heading", "code", "rule"]), j(kinds(d.blocks)))
check("le logo en <img> est gardé, sans balise", j(d.blocks[0].images) === j([{ src: "docs/logo.png", alt: "Logo" }]) && d.blocks[0].text === "" && d.blocks[0].center)
check("les ids de GitHub, et deux titres pareils n'ont pas le même", d.blocks[1].id === "zyvro-studio" && d.blocks[3].id === "install" && d.blocks[6].id === "install-1")
check("un titre souligné de ===", d.blocks[9].t === "heading" && d.blocks[9].level === 1 && d.blocks[9].text === "Title")
const ol = d.blocks[4]
check("une liste numérotée, et le paragraphe en retrait reste dans son élément", ol.ordered && ol.items.length === 2 && j(kinds(ol.items[1].blocks)) === j(["para", "para"]), j(ol.items.map((i) => kinds(i.blocks))))
const ul = d.blocks[5]
check("cases à cocher et liste imbriquée", ul.items[0].checked === true && ul.items[1].checked === false && ul.items[1].blocks[1]?.t === "list", j(ul))
const table = d.blocks[7]
check("un tableau aligné, `\\|` et `|` dans du code ne coupent pas la cellule", j(table.align) === j(["left", "right"]) && j(table.rows[0]) === j(["a | b", "`1|2`"]), j(table))
check("une citation continue sur la ligne paresseuse", d.blocks[8].blocks[0].text === "quoted\nlazy")
check("le code garde son texte et sa langue", d.blocks[10].lang === "ts" && d.blocks[10].text === "const x = 1")
check("les définitions de référence ne s'affichent pas", !JSON.stringify(d.blocks).includes("]: https") && d.refs.get("ci") === "https://example.com/ci")

const badge = t.parseInline(d.blocks[2].text, d.refs)
check("[![image][ref]][ref] : un lien qui contient une image", badge[0].t === "link" && badge[0].href === "https://example.com/ci" && badge[0].children[0].t === "image" && badge[0].children[0].src === "https://example.com/badge.svg", j(badge[0]))
check("gras au milieu d'une phrase", badge.some((x) => x.t === "strong"))

const I = (s) => j(t.parseInline(s, new Map()))
check("snake_case n'est pas de l'italique", I("a snake_case_name here") === j([{ t: "text", text: "a snake_case_name here" }]))
check("*em* et _em_", I("*a* _b_") === j([{ t: "em", children: [{ t: "text", text: "a" }] }, { t: "text", text: " " }, { t: "em", children: [{ t: "text", text: "b" }] }]))
check("le code en ligne ne s'interprète pas", I("`*x*`") === j([{ t: "code", text: "*x*" }]))
check("une URL nue devient un lien, sans le point final", I("see https://a.dev/x.") === j([{ t: "text", text: "see " }, { t: "link", href: "https://a.dev/x", children: [{ t: "text", text: "https://a.dev/x" }] }, { t: "text", text: "." }]))
check("deux espaces en fin de ligne : un saut", I("a  \nb") === j([{ t: "text", text: "a" }, { t: "br" }, { t: "text", text: "b" }]))
check("une balise en ligne disparaît, son texte reste", I("<kbd>Ctrl</kbd>") === j([{ t: "text", text: "Ctrl" }]))
check("un échappement", I("\\*not em\\*") === j([{ t: "text", text: "*not em*" }]))

const R = (doc, href) => j(t.resolveTarget(doc, href))
check("relatif au dossier du document", R("docs/guide/a.md", "../img/x.png") === j({ kind: "file", path: "docs/img/x.png", anchor: null }))
check("avec son ancre, et décodé", R("README.md", "docs/Mon%20guide.md#setup") === j({ kind: "file", path: "docs/Mon guide.md", anchor: "setup" }))
check("/ part de la racine du projet", R("docs/a.md", "/src/x.ts") === j({ kind: "file", path: "src/x.ts", anchor: null }))
check("rien ne sort du projet", t.resolveTarget("a.md", "../../etc/passwd") === null)
check("#ancre", R("a.md", "#install") === j({ kind: "anchor", id: "install" }))
check("le web", R("a.md", "https://x.dev") === j({ kind: "web", url: "https://x.dev" }))
check("javascript: n'est pas un lien", t.resolveTarget("a.md", "javascript:alert(1)") === null)
check("un document hors du projet résout à côté de lui", R("/Users/me/notes/a.md", "img/x.png") === j({ kind: "file", path: "/Users/me/notes/img/x.png", anchor: null }))

check("une liste ne boucle jamais sur une ligne vide d'élément", t.parseDoc("-\n-\n").blocks[0]?.t === "list")
check("un texte vide", t.parseDoc("").blocks.length === 0)

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUn README se lit comme sur GitHub.")
