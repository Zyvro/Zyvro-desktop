// Filtrer l'arbre en tapant (⌥⌘F).
//
// Ce qui casse en silence ici :
//
// 1. **Les dossiers qui mènent au résultat.** Un fichier trouvé sans ses
//    parents serait dessiné à la mauvaise profondeur, sous le mauvais dossier.
//
// 2. **L'ordre.** Dossiers d'abord, puis par nom — celui de l'arbre non filtré,
//    sinon la liste saute à chaque lettre tapée.
//
// 3. **Le nom, pas le chemin.** `src` ne doit pas ramener tout `src/` ; avec
//    un `/`, en revanche, c'est bien le chemin qu'on cherche.
//
// 4. **La limite.** Une lettre dans un gros dépôt ne dessine pas tout.
//
// 5. **Le câblage.** ⌥⌘F dans l'arbre et pas dans le menu (où il volerait
//    « Remplacer » à l'éditeur), Échap qui ferme.
//
//     node scripts/check-treefilter.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-treefilter-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/shared/treefilter").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const vue = (r) => r.rows.map((l) => `${"  ".repeat(l.depth)}${l.entry.name}${l.entry.kind === "directory" ? "/" : ""}`)

const files = [
  "README.md",
  "src/app/page.tsx",
  "src/app/Layout.tsx",
  "src/lib/pager.ts",
  "src/main.ts",
  "docs/homepage.md",
  "zeta/deep/er/Page.css",
]

const r = t.filterTree(files, "PAGE")
const attendu = ["docs/", "  homepage.md", "src/", "  app/", "    page.tsx", "  lib/", "    pager.ts", "zeta/", "  deep/", "    er/", "      Page.css"]
check("les fichiers trouvés, avec les dossiers qui y mènent, dans l'ordre de l'arbre", JSON.stringify(vue(r)) === JSON.stringify(attendu), JSON.stringify(vue(r)))
check("le compte ne compte que les fichiers", r.matched === 4 && !r.truncated, `${r.matched}`)
check("chaque ligne porte son chemin complet", r.rows.find((l) => l.entry.name === "er")?.entry.path === "zeta/deep/er")

check("un nom de dossier ne ramène pas tout son contenu", t.filterTree(files, "src").matched === 0)
check("avec un /, c'est le chemin qu'on cherche", JSON.stringify(t.filterTree(files, "app/pa").rows.map((l) => l.entry.path)) === JSON.stringify(["src", "src/app", "src/app/page.tsx"]))
check("les espaces autour ne comptent pas", t.filterTree(files, "  main ").matched === 1)
check("un filtre vide ne trouve rien", t.filterTree(files, "   ").rows.length === 0)
check("les fichiers d'abord dans l'ordre des dossiers, puis par nom sans casse", JSON.stringify(t.filterTree(files, ".ts").rows.map((l) => l.entry.name)) === JSON.stringify(["src", "app", "Layout.tsx", "page.tsx", "lib", "pager.ts", "main.ts"]))

const gros = Array.from({ length: t.FILTER_MAX + 50 }, (_, i) => `d${i % 7}/f${i}.ts`)
const g = t.filterTree(gros, "f")
check("au-delà de la limite, on s'arrête et on le dit", g.matched === t.FILTER_MAX && g.truncated)

const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
check("l'arbre filtré part de la liste de ⌘P (même clé)", /queryKey: \["files", "all", project\?\.project\]/.test(explorer) && /filterTree\(tous\.data\.files/.test(explorer))
check("⌥⌘F quand l'arbre a le focus", /event\.code === "KeyF" && event\.altKey/.test(explorer))
check("Échap ferme le filtre", /event\.key === "Escape" && filtre !== null/.test(explorer) && /closeTreeFilter\(\)/.test(explorer))
check("filtré, rien ne se replie", /r\.collapse && !filtrees/.test(explorer) && /onToggle=\{filtrees \? ignorer : toggle\}/.test(explorer))
const menu = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
const item = menu.match(/label: "Filter Files in Explorer",[\s\S]*?\}/)?.[0] ?? ""
check("dans le menu (donc la palette), sans raccourci", item !== "" && !/accelerator/.test(item) && /menu:filter-files/.test(item))
const bridge = readFileSync(path.join(ROOT, "src/renderer/lib/menuBridge.ts"), "utf8")
check("le menu ouvre l'arbre, puis le filtre", /setPanel\("explorer", true\)\s*\n\s*openTreeFilter/.test(bridge))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nL'arbre se filtre en tapant, sur tout le projet.")
