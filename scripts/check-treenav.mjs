// L'arbre de fichiers au clavier, et le fichier actif qu'il révèle.
//
// Ce qui casse en silence ici :
//
// 1. **Gauche sur un fichier.** Elle doit remonter au dossier parent, pas à la
//    ligne du dessus — qui peut être le dernier fichier d'un dossier voisin.
//
// 2. **Droite sur un dossier ouvert.** Elle descend dans son premier enfant ;
//    sur un dossier vide ou pas encore chargé, elle ne saute pas chez le voisin.
//
// 3. **Le défilement d'un arbre virtualisé.** La ligne visée n'existe peut-être
//    pas dans le DOM : on défile par le calcul, juste assez, et pas du tout
//    quand elle est déjà visible.
//
// 4. **Le câblage.** F2 et Suppr passent par les mêmes fonctions que le clic
//    droit, et le fichier actif est révélé.
//
//     node scripts/check-treenav.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-treenav-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/shared/treenav").replace(/\\/g, "/")}"\n`)
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

// src/ ouvert, avec lib/ ouvert dedans ; docs/ fermé ; un fichier à la racine.
const rows = [
  { path: "docs", kind: "directory", depth: 0 },
  { path: "src", kind: "directory", depth: 0 },
  { path: "src/lib", kind: "directory", depth: 1 },
  { path: "src/lib/a.ts", kind: "file", depth: 2 },
  { path: "src/main.ts", kind: "file", depth: 1 },
  { path: "src/empty", kind: "directory", depth: 1 },
  { path: "README.md", kind: "file", depth: 0 },
]
const ouverts = new Set(["src", "src/lib", "src/empty"])
const nav = (focus, key) => t.navigate(rows, focus, key, ouverts)
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check("sans focus, la première touche le pose en haut", eq(nav(null, "ArrowDown"), { focus: "docs" }))
check("bas", eq(nav("src/lib/a.ts", "ArrowDown"), { focus: "src/main.ts" }))
check("haut", eq(nav("src/main.ts", "ArrowUp"), { focus: "src/lib/a.ts" }))
check("rien au-delà de la dernière ligne", eq(nav("README.md", "ArrowDown"), {}))
check("Home et End", eq(nav("src/main.ts", "Home"), { focus: "docs" }) && eq(nav("docs", "End"), { focus: "README.md" }))
check("droite ouvre un dossier fermé", eq(nav("docs", "ArrowRight"), { expand: "docs" }))
check("**droite sur un dossier ouvert descend dans son premier enfant**", eq(nav("src", "ArrowRight"), { focus: "src/lib" }))
check("**mais pas chez le voisin quand il est vide**", eq(nav("src/empty", "ArrowRight"), {}))
check("droite sur un fichier ne fait rien", eq(nav("src/main.ts", "ArrowRight"), {}))
check("gauche referme un dossier ouvert", eq(nav("src/lib", "ArrowLeft"), { collapse: "src/lib" }))
check("**gauche sur un fichier remonte à son dossier, pas à la ligne du dessus**", eq(nav("src/main.ts", "ArrowLeft"), { focus: "src" }))
check("gauche à la racine ne fait rien", eq(nav("README.md", "ArrowLeft"), {}))
check("Entrée ouvre un fichier", eq(nav("src/main.ts", "Enter"), { open: "src/main.ts" }))
check("Entrée bascule un dossier", eq(nav("docs", "Enter"), { expand: "docs" }) && eq(nav("src", "Enter"), { collapse: "src" }))
check("une autre touche ne fait rien", eq(nav("src", "x"), {}))

check("les dossiers à déplier pour voir un fichier", eq(t.ancestorsOf("src/app/page.tsx"), ["src", "src/app"]))
check("un fichier à la racine n'en demande aucun", eq(t.ancestorsOf("README.md"), []))

check("**une ligne visible ne fait pas défiler**", t.scrollToShow(5, 26, 0, 260) === null)
check("au-dessus du cadre : on remonte jusqu'à elle", t.scrollToShow(2, 26, 200, 260) === 52)
check("en dessous : juste assez pour la voir en bas", t.scrollToShow(20, 26, 0, 260) === 21 * 26 - 260)

const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
check("**F2 et Suppr passent par les fonctions du clic droit**", /renameEntry\(entree, client\)/.test(explorer) && /trashEntry\(entree, client\)/.test(explorer))
check("le fichier actif est révélé", /ancestorsOf\(actif\)/.test(explorer))
check("et tout se replie d'un bouton", /title="Collapse Folders"/.test(explorer))
const actions = readFileSync(path.join(ROOT, "src/renderer/lib/entryActions.ts"), "utf8")
check(
  "un fichier mis à la corbeille ferme ses onglets propres, pas les modifiés",
  /isInside\(tab\.path, entry\.path\) && !\(tab\.id in store\.drafts\)/.test(actions)
)

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nL'arbre se parcourt au clavier, et montre le fichier qu'on regarde.")
