// Quick Open (⌘P) : trouver un fichier en tapant quelques lettres.
//
// Ce qui casse en silence ici :
//
// 1. **L'ordre.** Un résultat juste en quinzième position est un résultat
//    qu'on ne voit pas. Le nom du fichier passe devant le chemin, un début de
//    mot devant le milieu d'un mot, un chemin court devant un long.
//
// 2. **Les lettres dans l'ordre, pas côte à côte.** `edarea` doit trouver
//    `EditorArea.tsx`, `pan/term` doit trouver `panels/TerminalPanel.tsx`.
//
// 3. **`chemin:ligne`.** Ce qu'on copie d'une trace d'erreur. Sans découpage,
//    `app.ts:42` ne trouve rien, puisque aucun fichier ne s'appelle ainsi.
//
// 4. **Le parcours.** Les mêmes dossiers cachés que la recherche — un
//    `node_modules` dans la liste la noierait.
//
//     node scripts/check-fuzzy.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-fuzzy-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: {}, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${rel("src/shared/fuzzy")}"\nexport { listFiles } from "${rel("src/main/search")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const f = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const FICHIERS = [
  "src/renderer/panels/EditorArea.tsx",
  "src/renderer/panels/TerminalPanel.tsx",
  "src/main/terminal.ts",
  "src/renderer/state/workspace.ts",
  "docs/editor/area.md",
  "package.json",
  "vendor/old/app.ts",
  "src/app.ts",
  "src/renderer/panels/Explorer.tsx",
]
const premier = (q) => f.rank(q, FICHIERS, 5)[0]?.path

check("**les lettres dans l'ordre, pas côte à côte**", premier("edarea") === "src/renderer/panels/EditorArea.tsx", premier("edarea"))
check("un dossier puis un nom", premier("pan/term") === "src/renderer/panels/TerminalPanel.tsx", premier("pan/term"))
check("**le nom du fichier passe devant le chemin**", premier("area") === "src/renderer/panels/EditorArea.tsx" || premier("area") === "docs/editor/area.md", premier("area"))
check("à nom égal, le chemin le plus court", premier("app.ts") === "src/app.ts", premier("app.ts"))
check("la casse ne compte pas", premier("EXPL") === "src/renderer/panels/Explorer.tsx")
check("les espaces de la requête sont ignorées", premier("editor area") === "src/renderer/panels/EditorArea.tsx", premier("editor area"))
check("des lettres dans le désordre ne trouvent rien", f.rank("zxq", FICHIERS).length === 0)
check("requête vide : rien n'est écarté", f.fuzzyMatch("", "a/b.ts")?.score === 0)
check(
  "à score égal, l'ordre donné — les récents d'abord",
  f.rank("a", ["x/a.ts", "y/a.ts"])[0].path === "x/a.ts" && f.rank("a", ["y/a.ts", "x/a.ts"])[0].path === "y/a.ts"
)
{
  const m = f.fuzzyMatch("edar", "src/EditorArea.tsx")
  const lettres = m.positions.map((i) => "src/EditorArea.tsx"[i]).join("")
  check("les positions surlignées sont les bonnes lettres", lettres.toLowerCase() === "edar", lettres)
}

// ---- chemin:ligne ------------------------------------------------------------
{
  const a = f.splitLine("src/app.ts:42")
  check("**`chemin:42` ouvre à la ligne 42**", a.query === "src/app.ts" && a.line === 42 && a.column === null, JSON.stringify(a))
  const b = f.splitLine("app.ts:42:7")
  check("et `:42:7` à la colonne 7", b.line === 42 && b.column === 7)
  const c = f.splitLine("app")
  check("sans deux-points, rien n'est découpé", c.query === "app" && c.line === null)
  const d = f.splitLine("C:/work/app.ts")
  check("un `C:` de Windows n'est pas une ligne", d.query === "C:/work/app.ts" && d.line === null, JSON.stringify(d))
}

// ---- le parcours ------------------------------------------------------------
{
  const racine = mkdtempSync(path.join(tmpdir(), "zyvro-fuzzy-"))
  try {
    for (const p of ["src/a.ts", "src/deep/b.ts", "node_modules/x/index.js", ".git/HEAD", "README.md"]) {
      mkdirSync(path.dirname(path.join(racine, p)), { recursive: true })
      writeFileSync(path.join(racine, p), "x")
    }
    const { files, truncated } = await f.listFiles(racine)
    const tries = [...files].sort().join(",")
    check("**tous les fichiers, en chemins relatifs et en `/`**", tries === "README.md,src/a.ts,src/deep/b.ts", tries)
    check("et la liste se dit complète", truncated === false)
  } finally {
    rmSync(racine, { recursive: true, force: true })
  }
}

// ---- le câblage ---------------------------------------------------------------
{
  const menu = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check("**⌘P ouvre Go to File**", /label: "Go to File…",\s*accelerator: "CmdOrCtrl\+P"/.test(menu))
  const bridge = readFileSync(path.join(ROOT, "src/renderer/lib/menuBridge.ts"), "utf8")
  check("le rendu l'écoute", /onQuickOpen\(\(\) => \{\s*openQuickOpen\(\)/.test(bridge))
  const app = readFileSync(path.join(ROOT, "src/renderer/App.tsx"), "utf8")
  check("et la boîte est montée", /<QuickOpen \/>/.test(app))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nQuelques lettres suffisent à ouvrir un fichier.")
