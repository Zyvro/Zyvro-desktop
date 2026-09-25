// La barre d'état dit où l'on est dans le fichier, et comment il est écrit.
//
// Ce qui casse en silence ici :
//
// 1. **L'onglet d'à côté.** Tous les éditeurs restent montés ; si la barre
//    lisait « le dernier qui a parlé », elle afficherait la ligne d'un fichier
//    caché. Elle lit celui de l'onglet actif, et un onglet fermé n'y laisse
//    rien.
//
// 2. **Un rendu à chaque frappe pour rien.** Le curseur bouge sans cesse ;
//    publier un objet neuf quand rien n'a changé ferait redessiner la barre à
//    vide — et `useSyncExternalStore` veut le même objet tant que rien ne bouge.
//
//     node scripts/check-editor-status.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-editor-status-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/renderer/state/editorStatus").replace(/\\/g, "/")}"\n`
)
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

const base = { line: 3, column: 7, selected: 0, language: "TypeScript", eol: "LF", insertSpaces: true, tabSize: 2 }

check("**« Ln 3, Col 7 », comme VS Code**", t.positionText(base) === "Ln 3, Col 7")
check("et la sélection se compte", t.positionText({ ...base, selected: 12 }) === "Ln 3, Col 7 (12 selected)")
check("des espaces", t.indentationText(base) === "Spaces: 2")
check("des tabulations", t.indentationText({ ...base, insertSpaces: false, tabSize: 4 }) === "Tab Size: 4")

let emis = 0
t.subscribeEditorStatus(() => emis++)
const off = t.registerEditor("file:a.ts", { goToLine() {}, setEol() {}, setIndentation() {} })
t.publishEditorStatus("file:a.ts", base)
const premier = t.editorStatusOf("file:a.ts")
t.publishEditorStatus("file:a.ts", { ...base })
check("**rien n'a bougé : le même objet, et personne n'est réveillé**", t.editorStatusOf("file:a.ts") === premier && emis === 1, `émis ${emis} fois`)
t.publishEditorStatus("file:a.ts", { ...base, column: 8 })
check("un curseur qui bouge, si", emis === 2 && t.editorStatusOf("file:a.ts").column === 8)
check("**chaque onglet a le sien**", t.editorStatusOf("file:b.ts") === null)
off()
check("**un onglet fermé n'y laisse rien**", t.editorStatusOf("file:a.ts") === null && t.editorActionsOf("file:a.ts") === null)

const bar = readFileSync(path.join(ROOT, "src/renderer/panels/StatusBar.tsx"), "utf8")
check("la barre lit l'onglet actif du groupe qui a la main", /editorStatusOf\(tabId\)/.test(bar) && /useWorkspace\(\(s\) => focusedTabId\(s\)\)/.test(bar))
const editeur = readFileSync(path.join(ROOT, "src/renderer/panels/CodeEditor.tsx"), "utf8")
check("l'éditeur publie au mouvement du curseur", /onDidChangeCursorSelection\(publier\)/.test(editeur))
check("et se désinscrit en partant", /unregisterEditor\(\)/.test(editeur))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLa barre dit où est le curseur, dans le fichier qu'on regarde.")
