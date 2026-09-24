// Git dans l'arbre de fichiers : la couleur et la lettre de VS Code.
//
// Ce qui casse en silence ici :
//
// 1. **Le sous-dossier d'un dépôt.** git compte ses chemins depuis la racine du
//    dépôt, l'arbre depuis le projet ouvert. Sans le préfixe, un projet ouvert
//    dans `packages/app` ne décore rien — ou décore les mauvaises lignes.
//
// 2. **Un fichier à la fois indexé et modifié.** Il apparaît deux fois dans le
//    statut ; l'arbre n'a qu'une ligne, et le conflit passe devant tout.
//
// 3. **Les dossiers.** Un dossier replié qui contient un fichier modifié doit
//    le dire, sinon on ne voit rien de ce qu'on a touché tant qu'on n'a pas
//    tout déplié.
//
//     node scripts/check-gitdecor.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-gitdecor-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: {}, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${rel("src/shared/gitdecor")}"\nexport { status } from "${rel("src/main/git")}"\n`
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

{
  const { files, folders } = t.decorations(
    [
      { path: "src/a.ts", status: "modified", letter: "M" },
      { path: "src/new.ts", status: "untracked", letter: "?" },
      { path: "src/deep/gone.ts", status: "deleted", letter: "D" },
      { path: "src/both.ts", status: "added", letter: "A" },
      { path: "src/both.ts", status: "conflicted", letter: "U" },
      { path: "README.md", status: "added", letter: "A" },
    ],
    ""
  )
  check("un fichier modifié : M", files.get("src/a.ts")?.letter === "M" && files.get("src/a.ts")?.tone === "modified")
  check("**un fichier que git ne suit pas : U, comme VS Code, pas `?`**", files.get("src/new.ts")?.letter === "U")
  check("**le conflit l'emporte sur l'ajout**", files.get("src/both.ts")?.tone === "conflicted")
  check("**un dossier prend la couleur la plus grave de ce qu'il contient**", folders.get("src") === "conflicted", folders.get("src"))
  check("et chaque niveau au-dessus aussi", folders.get("src/deep") === "deleted")
  check("un fichier à la racine ne colore aucun dossier", ![...folders.keys()].includes(""))
}
{
  const { files, folders } = t.decorations(
    [
      { path: "packages/app/src/a.ts", status: "modified", letter: "M" },
      { path: "packages/other/b.ts", status: "modified", letter: "M" },
    ],
    "packages/app"
  )
  check("**dans un sous-dossier du dépôt, les chemins sont ceux du projet**", files.get("src/a.ts")?.letter === "M", JSON.stringify([...files]))
  check("et ce qui est hors du projet n'y est pas", files.size === 1 && !folders.has("packages"))
}

// ---- le vrai git -------------------------------------------------------------
{
  const depot = mkdtempSync(path.join(tmpdir(), "zyvro-gitdecor-"))
  const git = (...args) => spawnSync("git", args, { cwd: depot, encoding: "utf8" })
  try {
    if (git("init", "-q").status !== 0) {
      console.log("  skip  git absent : le préfixe n'est pas vérifié sur un vrai dépôt")
    } else {
      mkdirSync(path.join(depot, "packages/app"), { recursive: true })
      writeFileSync(path.join(depot, "packages/app/a.ts"), "x")
      const s = await t.status(path.join(depot, "packages/app"))
      check("**git dit où est le projet dans le dépôt**", s.repository && s.projectPrefix === "packages/app", JSON.stringify(s.projectPrefix))
      const racine = await t.status(depot)
      check("et rien quand le projet est la racine", racine.projectPrefix === "")
      const { files } = t.decorations([...s.staged, ...s.unstaged], s.projectPrefix)
      check("de bout en bout : le fichier nouveau est `U` sur sa ligne", files.get("a.ts")?.letter === "U", JSON.stringify([...files]))
    }
  } finally {
    rmSync(depot, { recursive: true, force: true })
  }
}

const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
check("l'arbre lit la même requête que le panneau Git", /useGitStatus\(Boolean\(project\)\)/.test(explorer))
check("et passe le préfixe du projet", /g\.projectPrefix/.test(explorer))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nL'arbre montre ce que git voit, là où on le cherche.")
