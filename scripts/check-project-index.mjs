// Les définitions d'un fichier à l'autre : les sources du projet données à
// TypeScript.
//
// Ce qui casse en silence ici :
//
// 1. **Le projet entier, node_modules compris.** Des dizaines de milliers de
//    fichiers lus à chaque ouverture : on garde les sources qu'on écrit, bornées.
// 2. **Une définition qui s'ouvre une ligne trop bas.** Monaco compte à partir
//    de 1, la demande d'affichage à partir de 0.
//
//     node scripts/check-project-index.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-project-index-check")
mkdirSync(dir, { recursive: true })
await build({ entryPoints: [path.join(ROOT, "src/shared/projectIndex.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const liste = ["src/a.ts", "src/b.tsx", "README.md", "node_modules/x/index.js", "dist/app.js", "lib/c.mjs", "web/vendor/jq.min.js", "types/g.d.ts", "src/.next/x.js", "tests/t.cjs"]
const pris = t.selectIndexable(liste)
check("**les sources qu'on écrit, pas ce qui se construit ou se télécharge**", JSON.stringify(pris) === JSON.stringify(["src/a.ts", "src/b.tsx", "lib/c.mjs", "types/g.d.ts", "tests/t.cjs"]), JSON.stringify(pris))
check("**borné**", t.selectIndexable(Array.from({ length: 5000 }, (_, i) => `s/${i}.ts`)).length === t.INDEX_MAX_FILES)

{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const idx = lire("src/renderer/lib/projectIndex.ts")
  check("données comme bibliothèques, pas comme fichiers vérifiés un à un", /typescriptDefaults\.setExtraLibs\(/.test(idx) && (idx.match(/createModel\(/g) ?? []).length === 1 && /createModel\("", langue\)/.test(idx))
  // Le seul modèle créé ici est vide, le temps d'éveiller le service d'une
  // langue pour ⌘T — et rendu aussitôt.
  check("le modèle d'éveil est rendu", /finally \{\s*eveil\.dispose\(\)/.test(idx))
  check("**une définition ailleurs ouvre son onglet, à la bonne ligne (de 1 à 0)**", /registerEditorOpener/.test(idx) && /line: sel\.startLineNumber - 1/.test(idx))
  check("relu après une rafale de changements, pas à chacun", /bientot\(10_000\)/.test(idx))
  check("chargé par l'application", /import "~\/lib\/projectIndex"/.test(lire("src/renderer/App.tsx")))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nF12 traverse les fichiers du projet.")
