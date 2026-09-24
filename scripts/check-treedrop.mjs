// Glisser-déposer sur l'arbre de fichiers : depuis le Finder, et d'un dossier à
// l'autre.
//
// Ce qui casse en silence ici :
//
// 1. **Un dossier déplacé dans lui-même.** Au survol, le dossier visé ne doit
//    pas s'allumer ; au lâcher, rien ne doit partir. Et `src` n'est pas dans
//    `src-old` : une comparaison de préfixe naïve dirait le contraire.
//
// 2. **L'onglet qui garde l'ancien chemin.** Un fichier ouvert puis déplacé
//    reste affiché ; la sauvegarde suivante le recrée là où il n'est plus — un
//    doublon silencieux à côté du vrai. Les onglets suivent, et leurs
//    brouillons avec.
//
// 3. **Un fichier écrasé à l'import.** Lâcher `notes.txt` dans un dossier qui
//    en a déjà un fait naître `notes 2.txt`, comme au collage. Et l'original,
//    sur le bureau, est toujours là : lâcher dans un éditeur copie.
//
// 4. **Le projet copié dans lui-même.** Lâcher la racine du projet, ou un
//    dossier qui contient la destination, sur l'arbre : la copie se recopierait
//    jusqu'au disque plein.
//
//     node scripts/check-treedrop.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-treedrop-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { shell: { trashItem: async () => {} }, app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  [
    `export * from "${path.join(ROOT, "src/shared/treedrop").replace(/\\/g, "/")}"`,
    `export { importEntries, pasteEntry } from "${path.join(ROOT, "src/main/files").replace(/\\/g, "/")}"`,
    `export { useWorkspace } from "${path.join(ROOT, "src/renderer/state/workspace").replace(/\\/g, "/")}"`,
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

// ---- où va ce qu'on lâche ------------------------------------------------
{
  check("sur un dossier, dedans", t.dropFolder({ path: "src/lib", kind: "directory" }) === "src/lib")
  check("sur un fichier, à côté de lui", t.dropFolder({ path: "src/lib/a.ts", kind: "file" }) === "src/lib")
  check("sur un fichier de la racine, à la racine", t.dropFolder({ path: "README.md", kind: "file" }) === "")
  check("dans le vide, à la racine", t.dropFolder(null) === "")
}

// ---- ce qui a un sens -----------------------------------------------------
{
  check("un fichier va dans un autre dossier", t.canMove("src/a.ts", "lib", "move"))
  check("**un dossier ne va pas dans lui-même**", !t.canMove("src", "src", "move"))
  check("**ni dans un de ses descendants**", !t.canMove("src", "src/lib/deep", "move"))
  check("mais `src` va dans `src-old`, qui n'est pas dedans", t.canMove("src", "src-old", "move"))
  check("déplacer vers son propre dossier n'est pas un déplacement", !t.canMove("src/a.ts", "src", "move"))
  check("le copier au même endroit, si : c'est un doublon voulu", t.canMove("src/a.ts", "src", "copy"))
  check("la racine elle-même ne se déplace pas", !t.canMove("", "src", "move"))
  check(
    "`src` et `src/a.ts` ensemble, c'est `src`",
    JSON.stringify(t.topmost(["src/a.ts", "src", "lib/b.ts"])) === JSON.stringify(["lib/b.ts", "src"])
  )
  check(
    "`src-old` n'est pas avalé par `src`",
    JSON.stringify(t.topmost(["src", "src-old/x"])) === JSON.stringify(["src", "src-old/x"])
  )
}

// ---- les chemins qui suivent ---------------------------------------------
{
  check("le fichier déplacé", t.retarget("src/a.ts", "src/a.ts", "lib/a.ts") === "lib/a.ts")
  check("ce qui est dans un dossier déplacé", t.retarget("src/x/a.ts", "src", "lib/src") === "lib/src/x/a.ts")
  check("un voisin au nom proche n'est pas concerné", t.retarget("src-old/a.ts", "src", "lib/src") === null)

  const { useWorkspace } = t
  useWorkspace.setState({
    project: { project: "/p", name: "p", daemon: {} },
    tabs: [
      { kind: "file", id: "file:src/a.ts", path: "src/a.ts", title: "a.ts" },
      { kind: "file", id: "file:src/b.ts", path: "src/b.ts", title: "b.ts" },
      { kind: "file", id: "file:srcx/c.ts", path: "srcx/c.ts", title: "c.ts" },
    ],
    activeTabId: "file:src/a.ts",
    drafts: { "file:src/a.ts": "pas encore enregistré" },
  })
  useWorkspace.getState().movePath("src", "lib/src")
  const s = useWorkspace.getState()
  check(
    "**les onglets d'un dossier déplacé le suivent**",
    s.tabs.map((tab) => tab.path).join(",") === "lib/src/a.ts,lib/src/b.ts,srcx/c.ts",
    s.tabs.map((tab) => tab.path).join(",")
  )
  check("l'onglet actif reste actif", s.activeTabId === "file:lib/src/a.ts", s.activeTabId)
  check("**le brouillon suit l'onglet**", s.drafts["file:lib/src/a.ts"] === "pas encore enregistré")
  check("et ne reste pas sous l'ancien nom", !("file:src/a.ts" in s.drafts))

  useWorkspace.getState().movePath("lib/src/a.ts", "lib/src/renamed.ts")
  check("un renommage change aussi le titre", useWorkspace.getState().tabs[0].title === "renamed.ts")
}

// ---- à la racine d'un projet --------------------------------------------
{
  check("un fichier du projet", t.relativeInside("/Users/x/p", "/Users/x/p/src/a.ts", "darwin") === "src/a.ts")
  check("un voisin au nom proche n'en est pas", t.relativeInside("/Users/x/p", "/Users/x/p2/a.ts", "darwin") === null)
  check("la racine elle-même n'est pas un fichier", t.relativeInside("/Users/x/p", "/Users/x/p", "darwin") === null)
  check(
    "Windows : séparateurs et casse",
    t.relativeInside("C:\\Work\\Proj", "c:\\work\\proj\\src\\a.ts", "win32") === "src/a.ts"
  )
  check(
    "ailleurs, la casse compte",
    t.relativeInside("/Users/x/Proj", "/Users/x/proj/a.ts", "linux") === null
  )
}

// ---- importer depuis le Finder -------------------------------------------
function arbre(contenu) {
  const racine = mkdtempSync(path.join(tmpdir(), "zyvro-treedrop-"))
  for (const [rel, texte] of Object.entries(contenu)) {
    const complet = path.join(racine, rel)
    if (texte === null) {
      mkdirSync(complet, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(complet), { recursive: true })
    writeFileSync(complet, texte)
  }
  return racine
}
const refus = async (fn) => {
  try {
    await fn()
    return null
  } catch (err) {
    return err
  }
}

{
  const bureau = arbre({ "notes.txt": "du bureau", "sprites/a.png": "png", "sprites/sub/b.png": "png2" })
  const projet = arbre({ "src/notes.txt": "déjà là", "README.md": "#" })
  try {
    const ecrits = await t.importEntries(
      projet,
      [path.join(bureau, "notes.txt"), path.join(bureau, "sprites")],
      "src"
    )
    check("les chemins rendus sont relatifs au projet", JSON.stringify(ecrits) === JSON.stringify(["src/notes 2.txt", "src/sprites"]), JSON.stringify(ecrits))
    check("**le fichier déjà là n'est pas écrasé**", readFileSync(path.join(projet, "src/notes.txt"), "utf8") === "déjà là")
    check("le nouveau prend un nom libre", readFileSync(path.join(projet, "src/notes 2.txt"), "utf8") === "du bureau")
    check("un dossier est copié en entier", readFileSync(path.join(projet, "src/sprites/sub/b.png"), "utf8") === "png2")
    check("**l'original est toujours sur le bureau**", existsSync(path.join(bureau, "notes.txt")) && existsSync(path.join(bureau, "sprites/a.png")))

    const racineDansElle = await refus(() => t.importEntries(projet, [projet], "src"))
    check("**le projet ne se copie pas dans lui-même**", racineDansElle !== null && /into itself/.test(racineDansElle.message), racineDansElle?.message)
    check("et rien n'a commencé à s'écrire", !existsSync(path.join(projet, "src", path.basename(projet))))

    const hors = await refus(() => t.importEntries(projet, [path.join(bureau, "notes.txt")], "../.."))
    check("la destination passe par le portail", hors !== null && /outside the open project/.test(hors.message), hors?.message)

    const relatif = await t.importEntries(projet, ["notes.txt"], "")
    check("un chemin relatif en source est ignoré, pas résolu", relatif.length === 0)

    const disparu = await refus(() => t.importEntries(projet, [path.join(bureau, "absent.txt")], ""))
    check("un fichier disparu entre-temps se dit", disparu !== null && /no longer there/.test(disparu.message), disparu?.message)
  } finally {
    rmSync(bureau, { recursive: true, force: true })
    rmSync(projet, { recursive: true, force: true })
  }
}

// ---- déplacer dans l'arbre ------------------------------------------------
{
  const projet = arbre({ "src/a.ts": "a", "lib": null })
  try {
    const ecrit = await t.pasteEntry(projet, "src/a.ts", "lib", "move")
    check("déplacer rend le nouveau chemin, en `/`", ecrit === "lib/a.ts", ecrit)
    check("le fichier est parti de là", !existsSync(path.join(projet, "src/a.ts")))
  } finally {
    rmSync(projet, { recursive: true, force: true })
  }
}

// ---- le pont et l'arbre ----------------------------------------------------
{
  const preload = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8")
  const bloc = preload.slice(preload.indexOf("importDropped"), preload.indexOf("files:import") + 20)
  check(
    "**le pont tire les chemins des `File`, le rendu n'en nomme aucun**",
    /importDropped: \(dropped: File\[\]/.test(preload) && /webUtils\.getPathForFile\(file\)/.test(bloc),
    "importDropped doit prendre des File et appeler webUtils.getPathForFile lui-même"
  )
  const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
  check("l'arbre pose les chemins relatifs sur ce qu'on attrape, sélection comprise", /setData\(ZYVRO_ENTRY, dragPaths\.join/.test(explorer))
  check("et fait suivre les onglets après un déplacement", /movePath\(from, ecrit\)/.test(explorer))
  // Renommer vit dans `entryActions`, partagé par le clic droit et F2.
  const renommer = readFileSync(path.join(ROOT, "src/renderer/lib/entryActions.ts"), "utf8")
  const menu = readFileSync(path.join(ROOT, "src/renderer/panels/EntryMenu.tsx"), "utf8")
  check(
    "renommer, par le menu ou par F2, fait suivre les onglets aussi",
    /movePath\(entry\.path, vers\)/.test(renommer) && /renameEntry\(entry, client\)/.test(menu)
  )
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\ntout est bon")
