// Couper, copier, coller dans l'arbre de fichiers.
//
// Ce qui casse en silence ici :
//
// 1. **Un fichier écrasé.** C'est la perte qu'aucune corbeille ne rattrape :
//    elle garde ce qu'on supprime, pas ce qu'on remplace. Coller sur un nom
//    déjà pris doit faire naître un nom libre, jamais recouvrir.
//
// 2. **Un dossier collé dans lui-même.** En copie, l'appel se rappellerait
//    jusqu'au disque plein ; en déplacement, l'arbre se détacherait de sa
//    racine. Les deux se refusent avant d'agir, pas au milieu.
//
// 3. **Le portail.** Un chemin vient du rendu. « ../.. » doit être refusé comme
//    partout ailleurs, sinon coller devient un moyen d'écrire hors du projet.
//
// 4. **Le chemin rendu.** Quand le nom demandé était pris, ce qui a été écrit
//    ne s'appelle pas comme on croit. L'appelant relit et ouvre ce chemin-là :
//    rendre l'ancien lui ferait ouvrir le fichier d'avant.
//
//     node scripts/check-paste.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-paste-check")
mkdirSync(dir, { recursive: true })

// `shell` d'electron ne sert qu'à la corbeille, que ce fichier n'exerce pas.
writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: { trashItem: async () => {} }, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { pasteEntry, listDir } from "${path.join(ROOT, "src/main/files").replace(/\\/g, "/")}"\n`
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
const { pasteEntry } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Un vrai dossier : coller est une opération de disque, et un faux système de
// fichiers ne dirait rien de ce qui casse — les collisions de noms, les
// dossiers récursifs, les liens.
function projet(arbre) {
  const racine = mkdtempSync(path.join(tmpdir(), "zyvro-paste-"))
  for (const [rel, contenu] of Object.entries(arbre)) {
    const complet = path.join(racine, rel)
    if (contenu === null) {
      mkdirSync(complet, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(complet), { recursive: true })
    writeFileSync(complet, contenu)
  }
  return racine
}
const lu = (racine, rel) => readFileSync(path.join(racine, rel), "utf8")
const la = (racine, rel) => existsSync(path.join(racine, rel))
const refus = async (fn) => {
  try {
    await fn()
    return null
  } catch (err) {
    return err.message
  }
}

// ---- copier ---------------------------------------------------------------
{
  const r = projet({ "src/a.txt": "un", "dest": null })
  const ecrit = await pasteEntry(r, "src/a.txt", "dest", "copy")
  check("**copier écrit à la destination**", ecrit === "dest/a.txt" && lu(r, "dest/a.txt") === "un", ecrit)
  check("et l'original reste", la(r, "src/a.txt"))
  rmSync(r, { recursive: true, force: true })
}

// ---- couper ---------------------------------------------------------------
{
  const r = projet({ "src/a.txt": "un", "dest": null })
  const ecrit = await pasteEntry(r, "src/a.txt", "dest", "move")
  check("**couper déplace**", ecrit === "dest/a.txt" && lu(r, "dest/a.txt") === "un", ecrit)
  check("et l'original n'est plus là", !la(r, "src/a.txt"))
  rmSync(r, { recursive: true, force: true })
}

// ---- rien n'est jamais écrasé ---------------------------------------------
//
// Le cœur du fichier. La corbeille garde ce qu'on supprime, pas ce qu'on
// remplace : un collage qui recouvre est une perte sans retour.
{
  const r = projet({ "src/a.txt": "le nouveau", "dest/a.txt": "CELUI QU'ON NE DOIT PAS PERDRE" })
  const ecrit = await pasteEntry(r, "src/a.txt", "dest", "copy")
  check("**un nom pris ne s'écrase pas**", lu(r, "dest/a.txt") === "CELUI QU'ON NE DOIT PAS PERDRE", lu(r, "dest/a.txt"))
  check("**il en naît un libre**", ecrit === "dest/a 2.txt" && lu(r, "dest/a 2.txt") === "le nouveau", ecrit)

  // Et le suivant compte plus loin, sans tourner en rond.
  const encore = await pasteEntry(r, "src/a.txt", "dest", "copy")
  check("et le suivant aussi", encore === "dest/a 3.txt", encore)

  // L'extension reste à la fin : « a.txt 2 » se trierait mal et n'ouvrirait
  // plus dans le bon programme.
  check("**l'extension reste à la fin**", ecrit.endsWith(".txt"), ecrit)
  rmSync(r, { recursive: true, force: true })
}

// ---- un dossier, avec ce qu'il contient -----------------------------------
{
  const r = projet({ "src/lot/a.txt": "un", "src/lot/sous/b.txt": "deux", "dest": null })
  const ecrit = await pasteEntry(r, "src/lot", "dest", "copy")
  check(
    "**un dossier part avec tout ce qu'il contient**",
    ecrit === "dest/lot" && lu(r, "dest/lot/a.txt") === "un" && lu(r, "dest/lot/sous/b.txt") === "deux",
    ecrit
  )
  rmSync(r, { recursive: true, force: true })
}

// ---- un dossier dans lui-même ---------------------------------------------
{
  const r = projet({ "lot/a.txt": "un", "lot/sous": null })
  check(
    "**un dossier ne se colle pas dans lui-même**",
    (await refus(() => pasteEntry(r, "lot", "lot", "copy"))) !== null,
    "la copie se rappellerait jusqu'au disque plein"
  )
  check(
    "**ni dans un de ses descendants**",
    (await refus(() => pasteEntry(r, "lot", "lot/sous", "move"))) !== null,
    "l'arbre se détacherait de sa racine"
  )
  check("et rien n'a bougé", la(r, "lot/a.txt") && !la(r, "lot/sous/lot"))
  rmSync(r, { recursive: true, force: true })
}

// ---- coller là où c'est déjà -----------------------------------------------
{
  const r = projet({ "src/a.txt": "un" })
  const ecrit = await pasteEntry(r, "src/a.txt", "src", "move")
  check("**couper vers son propre dossier ne fait rien**", ecrit === "src/a.txt" && !la(r, "src/a 2.txt"), ecrit)

  // Copier au même endroit, en revanche, duplique : c'est ce qu'on veut dire en
  // copiant-collant là où on est.
  const copie = await pasteEntry(r, "src/a.txt", "src", "copy")
  check("**mais copier au même endroit duplique**", copie === "src/a 2.txt" && lu(r, "src/a 2.txt") === "un", copie)
  rmSync(r, { recursive: true, force: true })
}

// ---- le portail ------------------------------------------------------------
{
  const r = projet({ "src/a.txt": "un" })
  check(
    "**on ne colle pas hors du projet**",
    (await refus(() => pasteEntry(r, "src/a.txt", "../ailleurs", "copy"))) !== null,
    "coller deviendrait un moyen d'écrire n'importe où"
  )
  check(
    "et on ne colle pas ce qui vient d'ailleurs",
    (await refus(() => pasteEntry(r, "../../etc/hosts", "src", "copy"))) !== null
  )
  rmSync(r, { recursive: true, force: true })
}

// ---- ce qui n'existe plus ---------------------------------------------------
{
  const r = projet({ "dest": null })
  const message = await refus(() => pasteEntry(r, "src/parti.txt", "dest", "move"))
  check("**coller ce qui a disparu se dit**", message !== null && message.includes("parti.txt"), String(message))
  rmSync(r, { recursive: true, force: true })
}

// ---- la racine du projet est un dossier comme un autre ---------------------
{
  const r = projet({ "src/a.txt": "un" })
  const ecrit = await pasteEntry(r, "src/a.txt", "", "copy")
  check("**coller à la racine marche**", ecrit === "a.txt" && lu(r, "a.txt") === "un", ecrit)
  rmSync(r, { recursive: true, force: true })
}

console.log(
  failures === 0
    ? "\nColler ajoute, et n'efface jamais ce qui était là."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
