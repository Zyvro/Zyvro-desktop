// Go to Symbol in Workspace (⌘T) : les symboles de tout le projet.
//
// Ce qui casse en silence ici :
//
// 1. **Le bruit.** Les variables locales d'une fonction, les imports, les
//    fonctions anonymes : sans filtre, ⌘T « user » rend cent `user` locaux
//    avant la classe `User`.
// 2. **Les membres.** Ceux d'une classe, d'une interface, d'une énumération
//    sont gardés, avec leur contenant.
// 3. **La position.** Ligne et colonne comptées à partir de 1, sur le nom.
// 4. **L'ordre.** Le nom exact d'abord, puis ceux qui commencent ainsi.
// 5. **Le câblage.** ⌘T ouvre la boîte avec `#`.
//
//     node scripts/check-workspace-symbols.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-wssym-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/shared/workspaceSymbols").replace(/\\/g, "/")}"\n`)
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

const text = `import { x } from "./x"
export class User {
  name = ""
  greet() { const user = 1; return user }
}
export function makeUser() {
  const user = new User()
  return user
}
export enum Role { Admin }
`
const at = (needle) => ({ start: text.indexOf(needle), length: needle.length })
const n = (text, kind, needle, childItems) => ({ text, kind, spans: [at(needle)], nameSpan: at(needle), childItems })
const tree = {
  text: '"a"',
  kind: "script",
  spans: [{ start: 0, length: text.length }],
  childItems: [
    n("x", "alias", "x }"),
    n("User", "class", "User {", [n("name", "property", "name ="), n("greet", "method", "greet()", [n("user", "const", "user = 1")])]),
    n("makeUser", "function", "makeUser()", [n("user", "const", "user = new")]),
    n("Role", "enum", "Role {", [n("Admin", "enum member", "Admin }")]),
    n("<function>", "function", "greet()"),
  ],
}
const syms = t.symbolsFrom("src/user.ts", tree, text)
const noms = syms.map((s) => (s.container ? `${s.container}.${s.name}` : s.name))
check("les déclarations et les membres, pas les locales ni les imports", JSON.stringify(noms) === JSON.stringify(["User", "User.name", "User.greet", "makeUser", "Role", "Role.Admin"]), JSON.stringify(noms))
const user = syms.find((s) => s.name === "User")
check("ligne et colonne à partir de 1, sur le nom", user.line === 2 && user.column === 14 && user.path === "src/user.ts", JSON.stringify(user))
const admin = syms.find((s) => s.name === "Admin")
check("un membre à la bonne ligne", admin.line === 10)

const r = t.searchSymbols(syms, "user").map((x) => x.symbol.name)
check("le nom exact d'abord, puis ceux qui commencent ainsi", r[0] === "User" && r.includes("makeUser"), JSON.stringify(r))
check("en flou : `mku` trouve makeUser", t.searchSymbols(syms, "mku")[0]?.symbol.name === "makeUser")
check("une requête vide ne rend rien", t.searchSymbols(syms, "  ").length === 0)

const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
const menu = lire("src/main/index.ts")
check("Go › Go to Symbol in Workspace…, ⌘T", /label: "Go to Symbol in Workspace…",\s*accelerator: "CmdOrCtrl\+T"/.test(menu))
check("qui ouvre la boîte avec #", /onWorkspaceSymbol\(\(\) => \{\s*openQuickOpen\("#"\)/.test(lire("src/renderer/lib/menuBridge.ts")))
const qo = lire("src/renderer/panels/QuickOpen.tsx")
check("la boîte cherche les symboles avec #", /saisie\.startsWith\("#"\)/.test(qo) && /searchSymbols\(/.test(qo) && /workspaceSymbols\(\)/.test(qo))
check("les symboles viennent de l'index de F12", /export function workspaceSymbols/.test(lire("src/renderer/lib/projectIndex.ts")))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\n⌘T trouve une déclaration n'importe où dans le projet.")
