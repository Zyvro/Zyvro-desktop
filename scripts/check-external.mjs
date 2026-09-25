// Les fichiers hors du projet : lâchés depuis le bureau sur l'éditeur, ou
// choisis par File › Open File…, ouverts et enregistrés à leur place.
//
// Ce qui casse en silence ici :
//
// 1. **La fenêtre qui lit tout le disque.** Un chemin absolu n'est lu ou écrit
//    que s'il a été accordé par un geste (lâché, choisi) ; n'importe quel autre
//    est refusé, même s'il existe.
//
// 2. **Deux onglets pour le même fichier.** Un fichier du projet lâché depuis
//    le Finder doit ouvrir l'onglet de l'arbre (chemin relatif), pas un second
//    sous son chemin absolu.
//
// 3. **Un binaire ouvert d'office.** Il s'annonce, et « Open Anyway » l'ouvre
//    quand même ; un script corrigé garde ses droits d'exécution.
//
//     node scripts/check-external.mjs
import { build } from "esbuild"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-external-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: { trashItem: async () => {} }, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  [
    `export * from "${path.join(ROOT, "src/shared/external").replace(/\\/g, "/")}"`,
    `export { grantedPath, openOutside, readAt, writeAt, readFile } from "${path.join(ROOT, "src/main/files").replace(/\\/g, "/")}"`,
    "",
  ].join("\n")
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
const refus = async (fn) => {
  try {
    await fn()
    return null
  } catch (err) {
    return err
  }
}

// ---- reconnaître un chemin du disque -------------------------------------------
check("`/Users/x/a.txt` est hors du projet", t.isAbsolutePath("/Users/x/a.txt"))
check("`C:/x/a.txt` et `C:\\x\\a.txt` aussi", t.isAbsolutePath("C:/x/a.txt") && t.isAbsolutePath("C:\\x\\a.txt"))
check("un partage réseau aussi", t.isAbsolutePath("\\\\serveur\\a.txt"))
check("**un chemin du projet n'en est jamais un**", !t.isAbsolutePath("src/a.ts") && !t.isAbsolutePath("C.ts") && !t.isAbsolutePath("c:"))
check("l'onglet écrit des `/`", t.tabPathOf("C:\\Users\\x\\a.txt") === "C:/Users/x/a.txt")
check("et le menu les rend au système", t.nativePath("C:/Users/x/a.txt", "win32") === "C:\\Users\\x\\a.txt" && t.nativePath("/a/b", "darwin") === "/a/b")

// ---- accorder ------------------------------------------------------------------
const racine = mkdtempSync(path.join(tmpdir(), "zyvro-external-"))
try {
  const projet = path.join(racine, "projet")
  const bureau = path.join(racine, "bureau")
  mkdirSync(path.join(projet, "src"), { recursive: true })
  mkdirSync(bureau, { recursive: true })
  writeFileSync(path.join(projet, "src", "a.ts"), "a")
  writeFileSync(path.join(bureau, "notes.txt"), "du bureau")
  writeFileSync(path.join(bureau, "secret.txt"), "à ne pas lire")
  writeFileSync(path.join(bureau, "prog.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1, 2, 0x41]))
  writeFileSync(path.join(bureau, "run.sh"), "#!/bin/sh\necho 1\n")
  if (process.platform !== "win32") chmodSync(path.join(bureau, "run.sh"), 0o755)

  const grants = new Set()
  const ouverts = await t.openOutside(grants, projet, [
    path.join(bureau, "notes.txt"),
    path.join(projet, "src", "a.ts"),
    bureau,
    "relatif.txt",
    path.join(bureau, "absent.txt"),
  ])
  const notes = t.tabPathOf(path.join(bureau, "notes.txt"))
  check("**le fichier du bureau s'ouvre sous son chemin absolu**", ouverts[0] === notes, JSON.stringify(ouverts))
  check("**celui du projet sous son chemin relatif, l'onglet de l'arbre**", ouverts[1] === "src/a.ts", JSON.stringify(ouverts))
  check("un dossier, un relatif, un disparu : écartés", ouverts.length === 2)
  check("seul le fichier d'ailleurs est accordé", grants.size === 1)

  const lu = await t.readAt(t.grantedPath(grants, notes), notes)
  check("il se lit", lu.text === "du bureau")
  await t.writeAt(t.grantedPath(grants, notes), "modifié")
  check("**et s'enregistre à sa place**", readFileSync(path.join(bureau, "notes.txt"), "utf8") === "modifié")

  const vole = await refus(() => t.grantedPath(grants, t.tabPathOf(path.join(bureau, "secret.txt"))))
  check("**un fichier voisin, jamais donné, est refusé**", vole !== null && /drop on it or choose/.test(vole.message), vole?.message)
  const detour = await refus(() => t.grantedPath(grants, t.tabPathOf(path.join(bureau, "x", "..", "secret.txt"))))
  check("même par un détour `..`", detour !== null)
  check("un chemin relatif passe par le projet, pas par ici", t.grantedPath(grants, "src/a.ts") === null)

  // ---- le binaire ----------------------------------------------------------------
  await t.openOutside(grants, projet, [path.join(bureau, "prog.bin"), path.join(bureau, "run.sh")])
  const bin = t.tabPathOf(path.join(bureau, "prog.bin"))
  const b1 = await t.readAt(t.grantedPath(grants, bin), bin)
  check("**un binaire s'annonce, il ne s'ouvre pas d'office**", b1.binary === true)
  const b2 = await t.readAt(t.grantedPath(grants, bin), bin, true)
  check("**« Open Anyway » l'ouvre quand même**", typeof b2.text === "string" && b2.text.endsWith("A"))

  const sh = t.tabPathOf(path.join(bureau, "run.sh"))
  await t.writeAt(t.grantedPath(grants, sh), "#!/bin/sh\necho 2\n")
  check("un script corrigé garde ses droits", process.platform === "win32" || (statSync(path.join(bureau, "run.sh")).mode & 0o777) === 0o755)
  const dansProjet = await t.readFile(projet, "src/a.ts")
  check("le projet se lit toujours par son portail", dansProjet.text === "a")
} finally {
  rmSync(racine, { recursive: true, force: true })
}

// ---- le câblage ------------------------------------------------------------------
{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const ipc = lire("src/main/ipc.ts")
  check("**lire et écrire passent par l'accord**", /const dehors = accorde\(ws, relative\)\s*\n\s*if \(dehors\) return files\.readAt/.test(ipc) && /if \(dehors\) await files\.writeAt/.test(ipc))
  const preload = lire("src/preload/index.ts")
  check("le pont tire les chemins des `File` lâchés", /openDropped: \(dropped: File\[\]\)/.test(preload))
  const drop = lire("src/renderer/lib/windowDrop.ts")
  check("un fichier lâché s'ouvre épinglé", /store\.pinTab\(`file:\$\{chemin\}`\)/.test(drop) && /files\.openDropped\(fichiers\)/.test(drop))
  const editeur = lire("src/renderer/panels/CodeEditor.tsx")
  check("« Open Anyway » sur un binaire", /Open Anyway/.test(editeur) && /files\.read\(path, true\)/.test(editeur))
  check("pas de marge git hors du projet", /if \(isAbsolutePath\(path\)\) return\s*\n\s*void window\.zyvro\.git\.headText/.test(editeur))
  const menu = lire("src/main/index.ts")
  check("File › Open File…", /label: "Open File…"/.test(menu))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUn fichier d'ailleurs s'ouvre, s'enregistre à sa place, et rien d'autre ne se lit.")
