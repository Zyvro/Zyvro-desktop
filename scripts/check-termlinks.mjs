// Les chemins du terminal deviennent des liens vers l'éditeur.
//
// Ce qui casse en silence ici :
//
// 1. **Une forme qu'on ne reconnaît pas.** tsc écrit `a.ts(12,5)` sans
//    `--pretty` et `a.ts:12:5` avec ; Python écrit `File "a.py", line 12` ;
//    Node met le chemin absolu entre parenthèses. Chacune manquée, c'est un
//    langage entier dont les erreurs ne se cliquent pas.
//
// 2. **Une adresse web prise pour un fichier.** `https://x.io/a/b.html` a une
//    extension ; c'est le lien web qui la prend, pas nous.
//
// 3. **Un chemin hors du projet.** L'éditeur ne lit que dans le projet ; un
//    lien vers `/etc/hosts` ou `../voisin` ne doit pas exister.
//
//     node scripts/check-termlinks.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-termlinks-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: {}, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${rel("src/shared/termlinks")}"\nexport { existingFiles } from "${rel("src/main/files")}"\n`
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
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const un = (texte) => {
  const [l] = t.findPathLinks(texte)
  return l ? { souligne: texte.slice(l.start, l.end), path: l.path, line: l.line, column: l.column } : null
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check("**tsc --pretty, eslint, go : chemin:ligne:colonne**", eq(un("src/app.ts:12:5 - error TS2322"), { souligne: "src/app.ts:12:5", path: "src/app.ts", line: 12, column: 5 }))
check("**tsc sans --pretty : chemin(ligne,colonne)**", eq(un("src/app.ts(12,5): error"), { souligne: "src/app.ts(12,5)", path: "src/app.ts", line: 12, column: 5 }))
check("**Python : File \"…\", line N**", eq(un('  File "app/main.py", line 12, in <module>'), { souligne: "app/main.py", path: "app/main.py", line: 12, column: null }))
check("Node : le chemin absolu entre parenthèses", un("    at fn (/home/u/p/src/app.ts:12:5)")?.path === "/home/u/p/src/app.ts")
check("un chemin nu", eq(un("see ./README.md"), { souligne: "./README.md", path: "./README.md", line: null, column: null }))
check("Windows", un("C:\\work\\p\\src\\a.ts:3:1")?.line === 3)
check("**une adresse web n'est pas un chemin**", t.findPathLinks("https://example.com/a/b.html").length === 0)
check("une version n'est pas un fichier", t.findPathLinks("release v1.2.3 and 1.5").length === 0)
check("plusieurs sur une ligne, dans l'ordre", t.findPathLinks("a.ts:1 b.ts:2").map((l) => l.path).join() === "a.ts,b.ts")

check("relatif : compté depuis la racine", t.toProjectPath("./src/a.ts", "/p", "linux") === "src/a.ts")
check("absolu dans le projet", t.toProjectPath("/home/u/p/src/a.ts", "/home/u/p", "linux") === "src/a.ts")
check("**absolu hors du projet : pas de lien**", t.toProjectPath("/etc/hosts.txt", "/home/u/p", "linux") === null)
check("**`../` : pas de lien**", t.toProjectPath("../voisin/a.ts", "/p", "linux") === null)
check("un voisin au nom proche non plus", t.toProjectPath("/home/u/p2/a.ts", "/home/u/p", "linux") === null)
check("Windows, sans la casse", t.toProjectPath("c:\\Work\\P\\src\\a.ts", "C:\\work\\p", "win32") === "src/a.ts")

{
  const racine = mkdtempSync(path.join(tmpdir(), "zyvro-termlinks-"))
  try {
    mkdirSync(path.join(racine, "src"))
    writeFileSync(path.join(racine, "src/a.ts"), "x")
    const r = await t.existingFiles(racine, ["src/a.ts", "e.g", "src", "../../etc/passwd"])
    check("**seul un vrai fichier du projet devient un lien**", eq(r, [true, false, false, false]), JSON.stringify(r))
  } finally {
    rmSync(racine, { recursive: true, force: true })
  }
}

const panneau = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
check("le terminal fournit ces liens", /term\.registerLinkProvider\(/.test(panneau) && /findPathLinks\(ligne\)/.test(panneau))
check("après avoir demandé s'ils existent", /window\.zyvro\.files\.exist\(/.test(panneau))
check("et un clic ouvre à la ligne", /revealAt\(\{ path: rel, line: l\.line - 1/.test(panneau))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUne erreur dans le terminal s'ouvre d'un clic, à la bonne ligne.")
