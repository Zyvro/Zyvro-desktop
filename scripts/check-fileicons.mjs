// Une icône par type de fichier, comme dans VS Code et Cursor.
//
// Ce qui casse en silence ici :
//
// 1. **L'ordre des règles.** `button.spec.ts` est un test avant d'être du
//    TypeScript, `package.json` est un `package.json` avant d'être du JSON.
//    L'extension courte d'abord, et tous les tests ressemblent à du code.
//
// 2. **Une icône nommée par la table mais absente du paquet.** L'arbre
//    montrerait une image cassée. Chaque nom que la table peut rendre doit
//    exister en SVG.
//
// 3. **La licence.** Material Icon Theme est sous MIT : sa notice voyage avec
//    l'application, ou on n'a pas le droit de la distribuer.
//
//     node scripts/check-fileicons.mjs
import { build } from "esbuild"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-fileicons-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/shared/fileicons").replace(/\\/g, "/")}"\n`)
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
const PKG = path.join(ROOT, "node_modules", "material-icon-theme")
const theme = JSON.parse(readFileSync(path.join(PKG, "dist", "material-icons.json"), "utf8"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const icone = (nom) => t.fileIconName(theme, nom)

check("TypeScript", icone("app.ts") === "typescript", icone("app.ts"))
check("React en TypeScript", icone("EditorArea.tsx") === "react_ts", icone("EditorArea.tsx"))
check("Go, Python, Markdown", icone("main.go") === "go" && icone("x.py") === "python" && icone("notes.txt") === "document")
check("**le nom exact avant l'extension : package.json**", icone("package.json") === "nodejs", icone("package.json"))
check("sans casse : Dockerfile", icone("Dockerfile") === "docker", icone("Dockerfile"))
check("**l'extension longue avant la courte : un test est un test**", icone("button.spec.ts") === "test-ts", icone("button.spec.ts"))
check("une déclaration aussi", icone("index.d.ts") === "typescript-def", icone("index.d.ts"))
check("un nom en point : .gitignore", icone(".gitignore") === "git", icone(".gitignore"))
check("l'inconnu prend l'icône par défaut", icone("données.zzzz") === theme.file)
check("la langue en dernier recours", t.fileIconName(theme, "a.qqq", (e) => (e === "qqq" ? "yaml" : undefined)) === theme.languageIds.yaml)
check("un dossier connu : src", t.folderIconName(theme, "src", false) === "folder-src")
check("et ouvert", t.folderIconName(theme, "src", true) === "folder-src-open")
check("un dossier inconnu", t.folderIconName(theme, "zzz", false) === theme.folder && t.folderIconName(theme, "zzz", true) === theme.folderExpanded)

// Chaque icône que la table peut rendre existe en SVG dans le paquet.
{
  const noms = new Set([
    theme.file,
    theme.folder,
    theme.folderExpanded,
    ...Object.values(theme.fileExtensions),
    ...Object.values(theme.fileNames),
    ...Object.values(theme.folderNames),
    ...Object.values(theme.folderNamesExpanded),
    ...Object.values(theme.languageIds),
  ])
  // Par la table des définitions : `sty` est dessinée par `sty.clone.svg`.
  const manquants = [...noms].filter((n) => {
    const fichier = t.iconFile(theme, n)
    return !fichier || !existsSync(path.join(PKG, "icons", fichier))
  })
  check(`**les ${noms.size} icônes que la table nomme existent toutes**`, manquants.length === 0, manquants.slice(0, 5).join(", "))
}

// La licence voyage avec l'application.
{
  const notice = readFileSync(path.join(ROOT, "THIRD-PARTY-NOTICES.md"), "utf8")
  const licence = readFileSync(path.join(PKG, "LICENSE"), "utf8").trim()
  const version = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")).version
  check("**la notice MIT est dans THIRD-PARTY-NOTICES.md**", notice.includes(licence.split("\n")[1] ?? licence))
  check("pour la version installée", notice.includes(`version ${version}`), `installée : ${version}`)
  const builder = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8")
  check("et elle est empaquetée", /^\s*- THIRD-PARTY-NOTICES\.md\s*$/m.test(builder))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nChaque fichier a l'icône de son type, et la licence qui va avec.")
