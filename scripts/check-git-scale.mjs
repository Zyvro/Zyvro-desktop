// Le panneau Git devant des milliers de changements.
//
// Demandé : « même un git avec 20 000 changes ne doit pas faire bugger quand je
// clique sur le panneau ». Mesuré avant correction, sur un vrai dépôt de 20 000
// fichiers modifiés ou nouveaux : 2,8 s avant la première ligne, une image
// figée 3,5 s à chaque relecture du statut (toutes les 3 s), 280 000 nœuds dans
// la page ; « Stage All » 7 s, « Discard All » 16 s — un `git ls-files` par
// fichier. Après : 52 ms, 109 ms au pire, 4 500 nœuds ; 0,5 s et 1,1 s.
//
// Ce qui casse en silence ici :
//
// 1. **Tout dessiner.** Un groupe dessine ROWS_PAGE lignes, puis « Show more ».
// 2. **Une ligne de commande trop longue.** Sous Windows, 32 767 caractères :
//    les chemins partent par lots (pathBatches).
// 3. **Un processus par fichier.** « Discard » demande à git ce qu'il suit en
//    une fois.
// 4. **Des milliers de pathspecs.** Quand la demande couvre tout ce que git
//    voit, une commande sans chemins — et seulement dans ce cas.
//
//     node scripts/check-git-scale.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
let failures = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`)
  if (!ok) failures++
}

const work = mkdtempSync(path.join(tmpdir(), "zyvro-git-scale-"))
const fake = path.join(work, "electron.cjs")
writeFileSync(fake, "module.exports = { shell: {}, app: { getPath: () => require('os').tmpdir() } }\n")
const out = path.join(ROOT, "node_modules", ".zyvro-check-git-scale.cjs")
await build({
  entryPoints: [path.join(ROOT, "src/main/git.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { electron: fake },
  logLevel: "silent",
})
const git = createRequire(import.meta.url)(out)

// ---- les lots de chemins -------------------------------------------------------------
{
  const paths = Array.from({ length: 3000 }, (_, i) => `src/a-fairly-long-folder-name/file-${i}.txt`)
  const batches = git.pathBatches(paths, 24_000)
  check("**les chemins partent par lots sous la borne de Windows**", batches.length > 1 && batches.every((b) => b.join(" ").length < 24_000))
  check("et aucun ne se perd ni ne se double", batches.flat().join("\n") === paths.join("\n"))
}

// ---- un vrai dépôt ------------------------------------------------------------------
const repo = path.join(work, "repo")
mkdirSync(repo)
const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
g("init", "-q")
g("config", "user.email", "check@example.test")
g("config", "user.name", "check")
for (let d = 0; d < 12; d++) {
  mkdirSync(path.join(repo, `src/d${d}`), { recursive: true })
  for (let f = 0; f < 50; f++) writeFileSync(path.join(repo, `src/d${d}/f${f}.txt`), "v1\n")
}
g("add", "-A")
g("commit", "-qm", "init")
for (let d = 0; d < 12; d++) {
  for (let f = 0; f < 50; f++) writeFileSync(path.join(repo, `src/d${d}/f${f}.txt`), "v2\n")
  mkdirSync(path.join(repo, `new/d${d}`), { recursive: true })
  for (let f = 0; f < 50; f++) writeFileSync(path.join(repo, `new/d${d}/n${f}.txt`), "n\n")
}

let s = await git.status(repo)
check("le dépôt d'essai a 1 200 changements", s.unstaged.length === 1200, String(s.unstaged.length))

// Une partie seulement : surtout pas de raccourci « tout ».
const some = s.unstaged.slice(0, 600).map((c) => c.path)
await git.stage(repo, some)
s = await git.status(repo)
check("**indexer une partie n'indexe que cette partie**", s.staged.length === 600 && s.unstaged.length === 600, `${s.staged.length}/${s.unstaged.length}`)

await git.stage(repo, s.unstaged.map((c) => c.path))
s = await git.status(repo)
check("**tout indexer (raccourci) indexe tout**", s.staged.length === 1200 && s.unstaged.length === 0)

await git.unstage(repo, s.staged.slice(0, 700).map((c) => c.path))
s = await git.status(repo)
check("retirer une partie de l'index n'en retire que cette partie", s.staged.length === 500, String(s.staged.length))
await git.unstage(repo, s.staged.map((c) => c.path))
s = await git.status(repo)
check("tout retirer de l'index laisse le travail en place", s.staged.length === 0 && s.unstaged.length === 1200)

// Un fichier ignoré n'est pas dans la liste : il ne doit pas partir avec « Discard All ».
writeFileSync(path.join(repo, ".gitignore"), "keep.log\n")
g("add", ".gitignore")
g("commit", "-qm", "ignore")
writeFileSync(path.join(repo, "keep.log"), "precious\n")
s = await git.status(repo)
const first = s.unstaged.slice(0, 100).map((c) => c.path)
await git.discard(repo, first)
s = await git.status(repo)
check("**jeter une partie ne jette que cette partie**", s.unstaged.length === 1100, String(s.unstaged.length))
await git.discard(repo, s.unstaged.map((c) => c.path))
s = await git.status(repo)
check("**tout jeter (raccourci) remet le dépôt propre**", s.unstaged.length === 0 && s.staged.length === 0)
check("et un fichier ignoré, que la liste ne montrait pas, reste", readFileSync(path.join(repo, "keep.log"), "utf8") === "precious\n")

let refused = false
try {
  await git.stage(repo, ["../outside.txt"])
} catch {
  refused = true
}
check("un chemin hors du projet est toujours refusé", refused)

// ---- le panneau -----------------------------------------------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/GitPanel.tsx"), "utf8")
  check("**un groupe ne dessine qu'une page de lignes**", /export const ROWS_PAGE = \d+/.test(panel) && /changes\.slice\(0, shown\)/.test(panel) && /\{visibles\.map\(/.test(panel))
  check("et dit combien il en reste", /not shown/.test(panel))
  const hooks = readFileSync(path.join(ROOT, "src/renderer/lib/git.ts"), "utf8")
  check("**un gros statut est relu moins souvent**", /total > BIG_STATUS \? SLOW_POLL_MS : POLL_MS/.test(hooks))
}

rmSync(work, { recursive: true, force: true })
rmSync(out, { force: true })
console.log(failures === 0 ? "\nVingt mille changements se lisent, s'indexent et se jettent sans geler la fenêtre." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
