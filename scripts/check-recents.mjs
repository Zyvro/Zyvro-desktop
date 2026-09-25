// Les fichiers récents : File › Open Recent et ⌘P, d'une session à l'autre.
//
// Ce qui casse en silence ici :
//
// 1. **Les fichiers d'un autre projet.** La liste est par projet : ouvrir B ne
//    montre pas les fichiers de A.
// 2. **Des entrées mortes.** Un fichier supprimé depuis ne revient pas dans le
//    menu.
// 3. **Un fichier d'ailleurs, ou un chemin qui sort du projet**, retenu comme
//    s'il en était.
//
//     node scripts/check-recents.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-recents-check")
mkdirSync(dir, { recursive: true })
const donnees = mkdtempSync(path.join(tmpdir(), "zyvro-recents-"))
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(donnees)}, addRecentDocument() {}, clearRecentDocuments() {} } }\n`
)
await build({
  entryPoints: [path.join(ROOT, "src/main/recents.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
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

check("le dernier ouvert passe devant, sans doublon", t.pushRecent(["a", "b", "c"], "b", 5).join() === "b,a,c")
check("la liste est bornée", t.pushRecent(["a", "b", "c"], "d", 3).join() === "d,a,b")

try {
  const A = path.join(donnees, "A")
  const B = path.join(donnees, "B")
  for (const [p, f] of [[A, "src/x.ts"], [A, "README.md"], [A, "parti.ts"], [B, "b.go"]]) {
    mkdirSync(path.dirname(path.join(p, f)), { recursive: true })
    writeFileSync(path.join(p, f), "")
  }
  check("retenir un fichier dit que le menu change", t.rememberFile(A, "src/x.ts") === true)
  t.rememberFile(A, "parti.ts")
  t.rememberFile(A, "README.md")
  check("le même en tête : rien à refaire", t.rememberFile(A, "README.md") === false)
  t.rememberFile(B, "b.go")
  check("**chaque projet a les siens**", t.recentFiles(A).join() === "README.md,parti.ts,src/x.ts" && t.recentFiles(B).join() === "b.go", t.recentFiles(A).join())
  rmSync(path.join(A, "parti.ts"))
  check("**un fichier supprimé ne revient pas**", t.recentFiles(A).join() === "README.md,src/x.ts")
  t.forgetRecents()
  check("Clear Recently Opened vide aussi les fichiers", t.recentFiles(A).length === 0)
} finally {
  rmSync(donnees, { recursive: true, force: true })
}

{
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  check(
    "**ni fichier d'ailleurs ni `..` dans la liste**",
    /isAbsolutePath\(rel\) \|\| rel\.split\("\/"\)\.includes\(".."\)\) return false/.test(ipc)
  )
  const menu = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check("le menu suit la fenêtre au premier plan", /app\.on\("browser-window-focus", \(\) => buildMenu\(\)\)/.test(menu) && /recentFiles\(projet\)/.test(menu))
  const qo = readFileSync(path.join(ROOT, "src/renderer/panels/QuickOpen.tsx"), "utf8")
  check("⌘P les propose aussi", /for \(const p of retenus\.data \?\? \[\]\) ajouter\(p\)/.test(qo))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLes fichiers d'hier se rouvrent d'un geste, ceux de ce projet seulement.")
