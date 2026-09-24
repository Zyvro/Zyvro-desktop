// La marge de git dans l'éditeur : ce qui a changé depuis le dernier commit.
//
// Ce qui casse en silence ici :
//
// 1. **Le numéro de ligne.** Une barre posée une ligne trop bas ne dit plus
//    rien. Chaque cas — ajout, modification, suppression, en haut, au milieu,
//    en bas — tombe sur sa ligne.
//
// 2. **Le coût.** Le diff se refait après chaque frappe. Un fichier de vingt
//    mille lignes touché à deux endroits doit rester instantané, et un fichier
//    réécrit de bout en bout ne doit ni geler la fenêtre ni avaler la mémoire.
//
// 3. **Un projet dans un sous-dossier du dépôt.** `HEAD:chemin` se lit depuis
//    la racine du dépôt ; `HEAD:./chemin` depuis le dossier du projet.
//
//     node scripts/check-linediff.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-linediff-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: {}, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${rel("src/shared/linediff")}"\nexport { headText, output } from "${rel("src/main/git")}"\n`
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
const diff = (a, b) => JSON.stringify(t.lineChanges(a, b))
const eq = (a, b, attendu) => diff(a, b) === JSON.stringify(attendu)

check("rien de changé, rien de marqué", eq("a\nb\n", "a\nb\n", []))
check("**une ligne ajoutée au milieu**", eq("a\nb\nc\n", "a\nX\nb\nc\n", [{ kind: "added", start: 2, end: 2 }]), diff("a\nb\nc\n", "a\nX\nb\nc\n"))
check("**une ligne modifiée**", eq("a\nb\nc\n", "a\nB\nc\n", [{ kind: "modified", start: 2, end: 2 }]))
check("**une ligne supprimée : le triangle sous la ligne d'avant**", eq("a\nb\nc\n", "a\nc\n", [{ kind: "deleted", start: 1, end: 1 }]))
check("supprimée tout en haut : ligne 0", eq("a\nb\nc\n", "b\nc\n", [{ kind: "deleted", start: 0, end: 0 }]))
check("ajoutées à la fin", eq("a\nb\n", "a\nb\nc\nd\n", [{ kind: "added", start: 3, end: 4 }]))
check("deux endroits à la fois", eq("a\nb\nc\nd\n", "a\nB\nc\nD\nE\n", [{ kind: "modified", start: 2, end: 2 }, { kind: "modified", start: 4, end: 5 }]))
check("un fichier vide qui se remplit : ajouté, pas modifié", eq("", "x\ny\n", [{ kind: "added", start: 1, end: 2 }]))
check("les fins de ligne CRLF ne font pas tout changer", eq("a\r\nb\r\n", "a\nb\n", []))

{
  const gros = Array.from({ length: 20000 }, (_, i) => `ligne ${i}`).join("\n")
  const t0 = performance.now()
  const r = t.lineChanges(gros, gros.replace("ligne 100\n", "LIGNE 100\n").replace("ligne 15000\n", ""))
  const ms = performance.now() - t0
  check(`**vingt mille lignes touchées à deux endroits : ${ms.toFixed(0)} ms**`, ms < 200 && r.length === 2, JSON.stringify(r))
  const t1 = performance.now()
  const tout = t.lineChanges(gros, Array.from({ length: 20000 }, (_, i) => `autre ${i}`).join("\n"))
  const ms2 = performance.now() - t1
  check(`**réécrit de bout en bout : borné (${ms2.toFixed(0)} ms), et marqué modifié**`, ms2 < 2000 && tout.length === 1 && tout[0].kind === "modified")
}

{
  const depot = mkdtempSync(path.join(tmpdir(), "zyvro-linediff-"))
  const git = (...args) => spawnSync("git", args, { cwd: depot, encoding: "utf8" })
  try {
    if (git("init", "-q").status !== 0) {
      console.log("  skip  git absent")
    } else {
      mkdirSync(path.join(depot, "pkg/src"), { recursive: true })
      writeFileSync(path.join(depot, "pkg/src/a.ts"), "commité\n")
      git("add", "-A")
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
      writeFileSync(path.join(depot, "pkg/src/a.ts"), "modifié\n")
      writeFileSync(path.join(depot, "pkg/src/nouveau.ts"), "x\n")
      const avant = t.output().length
      const texte = await t.headText(path.join(depot, "pkg"), "src/a.ts")
      check("**le texte commité, depuis un projet ouvert dans un sous-dossier**", texte === "commité\n", JSON.stringify(texte))
      check("un fichier jamais commité : rien à comparer", (await t.headText(path.join(depot, "pkg"), "src/nouveau.ts")) === null)
      check("**et la marge n'encombre pas Git Output**", t.output().length === avant, `${t.output().length - avant} commande(s) ajoutée(s)`)
    }
  } finally {
    rmSync(depot, { recursive: true, force: true })
  }
}

const editeur = readFileSync(path.join(ROOT, "src/renderer/panels/CodeEditor.tsx"), "utf8")
check("l'éditeur marque sa marge", /marques\.set\(/.test(editeur) && /lineChanges\(head, editor\.getValue\(\)\)/.test(editeur))
check("et relit HEAD quand il bouge", /sha !== headDe/.test(editeur))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLa marge dit ce qui a changé depuis le dernier commit, ligne pour ligne.")
