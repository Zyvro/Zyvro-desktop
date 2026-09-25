// L'aperçu Markdown (⇧⌘V).
//
// Ce qui casse en silence ici :
//
// 1. **Un aperçu qui ne suit pas.** Il montre le brouillon de l'onglet
//    d'édition s'il y en a un — ce qu'on est en train d'écrire — et sinon le
//    fichier, par la même requête que l'éditeur, relue à l'enregistrement.
//
// 2. **Du HTML brut.** Un README venu d'ailleurs ne doit pas pouvoir glisser de
//    balise dans la fenêtre : le rendu (`MarkdownDoc`) n'utilise jamais
//    `dangerouslySetInnerHTML`.
//
// 3. **Un aperçu orphelin.** Renommer le fichier doit renommer son aperçu.
//
//     node scripts/check-preview.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-preview-check")
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

useWorkspace.setState({ project: { project: "/p", name: "p", daemon: {} }, tabs: [], activeTabId: "", drafts: {}, closedFiles: [] })
const s = useWorkspace.getState
s().openFile("docs/README.md")
s().openPreview("docs/README.md")
check("l'aperçu s'ouvre dans son propre onglet", s().activeTabId === "preview:docs/README.md" && s().tabs.length === 2)
s().openPreview("docs/README.md")
check("un seul aperçu par fichier", s().tabs.length === 2)
s().movePath("docs", "guide")
check(
  "**renommer le dossier renomme l'aperçu aussi**",
  s().tabs.map((t) => t.id).join() === "file:guide/README.md,preview:guide/README.md",
  s().tabs.map((t) => t.id).join()
)
check("et son titre", s().tabs[1].title === "Preview README.md")

const tab = readFileSync(path.join(ROOT, "src/renderer/panels/PreviewTab.tsx"), "utf8")
check("**l'aperçu suit le brouillon**", /s\.drafts\[`file:\$\{path\}`\]/.test(tab))
check("et le fichier par la même requête que l'éditeur", /queryKey: \["files", "read", path\]/.test(tab))
const md = readFileSync(path.join(ROOT, "src/renderer/panels/MarkdownDoc.tsx"), "utf8")
check("**le rendu n'accepte pas de HTML brut**", /import \{ MarkdownDoc \} from "\.\/MarkdownDoc"/.test(tab) && !/dangerouslySetInnerHTML/.test(md))
const menu = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
check("⇧⌘V ouvre l'aperçu", /label: "Open Markdown Preview",\s*accelerator: "CmdOrCtrl\+Shift\+V"/.test(menu))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUn Markdown se lit rendu, pendant qu'on l'écrit.")
