// Comparer deux fichiers : « Select for Compare », puis « Compare with
// Selected » (clic droit de l'arbre), comme VS Code.
//
// Ce qui casse en silence ici :
//
// 1. **Le sens.** Le fichier choisi en premier est à gauche.
// 2. **Un seul onglet par paire**, rouvert plutôt que doublé.
// 3. **Un renommage.** L'onglet suit ses deux fichiers, sinon il compare un
//    fichier qui n'existe plus.
// 4. **Le câblage.** Le menu, et la vue qui lit les deux fichiers du disque.
//
//     node scripts/check-compare.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-compare-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/renderer/state/workspace").replace(/\\/g, "/")}"\n`)
await build({ entryPoints: [path.join(dir, "h.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", absWorkingDir: ROOT, logLevel: "silent" })
const { useWorkspace } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const ws = useWorkspace.getState
ws().openCompare("src/a.ts", "src/b.ts")
const tab = ws().tabs.find((t) => t.kind === "diff")
check("le premier choisi à gauche, l'autre à droite", tab?.against === "src/a.ts" && tab?.path === "src/b.ts", JSON.stringify(tab))
check("le titre nomme les deux", tab?.title === "a.ts ↔ b.ts")
check("l'onglet est actif", ws().activeTabId === tab?.id)
ws().openCompare("src/a.ts", "src/b.ts")
check("une paire, un onglet", ws().tabs.filter((t) => t.kind === "diff").length === 1)
ws().movePath("src", "lib")
const suivi = ws().tabs.find((t) => t.kind === "diff")
check("un dossier renommé : la comparaison suit ses deux fichiers", suivi?.against === "lib/a.ts" && suivi?.path === "lib/b.ts" && ws().activeTabId === suivi?.id, JSON.stringify(suivi))

const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
const menu = lire("src/renderer/panels/EntryMenu.tsx")
check("le clic droit : Select for Compare, puis Compare with Selected", /selectForCompare\(entry\.path\)/.test(menu) && /openCompare\(aComparer, entry\.path\)/.test(menu) && /aComparer !== entry\.path/.test(menu))
const vue = lire("src/renderer/panels/DiffView.tsx")
check("la vue lit les deux fichiers du disque", /files\.read\(against\)/.test(vue) && /files\.read\(path\)/.test(vue))
check("et dit quand l'un n'est pas du texte", /is not text/.test(vue))
const zone = lire("src/renderer/panels/EditorArea.tsx")
check("l'onglet passe `against` à la vue", /against=\{tab\.against\}/.test(zone))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nDeux fichiers se comparent en deux clics.")
