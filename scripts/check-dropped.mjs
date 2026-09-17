// Un fichier lâché depuis le Finder, et ce qu'il écrit.
//
// Ce qui casse en silence ici :
//
// 1. **Un nom de fichier est un texte écrit par quelqu'un d'autre.** Ce qu'on
//    dépose sur le terminal part dans un shell qui l'exécute. `mon fichier.txt`
//    sans apostrophes est deux arguments ; `$(rm -rf ~).txt` est un nom de
//    fichier légal et une commande. Les deux panneaux doivent citer, et de la
//    même façon — un chemin cité d'un côté et brut de l'autre, c'est le
//    terminal qui casse, et seulement chez les gens dont les dossiers ont des
//    espaces.
//
// 2. **Le curseur.** Un chemin collé à la fin quand on écrivait au milieu est
//    un chemin qu'il faut déplacer à la main. Et collé contre le mot d'avant,
//    c'est un mot de plus que personne n'a écrit.
//
// 3. **`File.path` n'existe plus.** Electron l'a retiré en 32. Un rendu qui le
//    lit obtient `undefined` et dépose une chaîne vide : rien ne se passe, et
//    rien ne dit pourquoi.
//
//     node scripts/check-dropped.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-dropped-check")
mkdirSync(dir, { recursive: true })

writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/shared/dropped").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const dropped = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- ce qui part dans un shell -------------------------------------------
{
  check(
    "un chemin ordinaire s'écrit tel quel",
    dropped.quotePath("/Users/x/projet/src/app.ts", "darwin") === "/Users/x/projet/src/app.ts"
  )
  check(
    "**une espace est citée**",
    dropped.quotePath("/Users/x/mes documents/a.txt", "darwin") === "'/Users/x/mes documents/a.txt'",
    dropped.quotePath("/Users/x/mes documents/a.txt", "darwin")
  )

  // Le cas qui n'a pas l'air d'en être un : c'est un nom de fichier légal.
  const piege = "/Users/x/$(rm -rf ~).txt"
  const cite = dropped.quotePath(piege, "darwin")
  check(
    "**un nom de fichier qui ressemble à une commande n'en devient pas une**",
    cite === `'${piege}'`,
    cite
  )
  check(
    "une apostrophe dans le nom ne referme pas la citation",
    dropped.quotePath("/Users/x/l'été.txt", "darwin") === "'/Users/x/l'\\''été.txt'",
    dropped.quotePath("/Users/x/l'été.txt", "darwin")
  )
  check(
    "**Windows cite avec ce que cmd et PowerShell comprennent**",
    dropped.quotePath("C:\\Users\\x\\mes documents\\a.txt", "win32") === '"C:\\Users\\x\\mes documents\\a.txt"',
    dropped.quotePath("C:\\Users\\x\\mes documents\\a.txt", "win32")
  )
  check("et un guillemet y est doublé", dropped.quotePath('C:\\a"b', "win32") === '"C:\\a""b"')

  check(
    "**plusieurs fichiers d'un coup, séparés par une espace**",
    dropped.droppedText(["/a/un", "/a/deux trois"], "darwin") === "/a/un '/a/deux trois'",
    dropped.droppedText(["/a/un", "/a/deux trois"], "darwin")
  )
  check("un chemin vide ne laisse pas d'espace derrière lui", dropped.droppedText(["", "/a/b"], "darwin") === "/a/b")
}

// ---- là où était le curseur ----------------------------------------------
{
  const out = dropped.insertAt("regarde  et dis-moi", 8, 8, "/a/b.ts")
  check("**le chemin arrive où était le curseur**", out.value === "regarde /a/b.ts et dis-moi", out.value)
  check("et le curseur passe derrière", out.cursor === "regarde /a/b.ts".length, String(out.cursor))

  const collé = dropped.insertAt("regarde", 7, 7, "/a/b.ts")
  check("**un chemin lâché contre un mot ne s'y colle pas**", collé.value === "regarde /a/b.ts", collé.value)

  const vide = dropped.insertAt("", 0, 0, "/a/b.ts")
  check("dans un champ vide, pas d'espace en tête", vide.value === "/a/b.ts", vide.value)

  const remplace = dropped.insertAt("regarde ceci", 8, 12, "/a/b.ts")
  check("**ce qui était sélectionné est remplacé**", remplace.value === "regarde /a/b.ts", remplace.value)
}

// ---- ce que l'arbre de l'application dépose ------------------------------
//
// Deux sources pour un même geste : le Finder donne des `File`, l'arbre donne
// du texte sous un type à nous. Ce type existe pour qu'un dépôt de texte
// ordinaire — une phrase glissée depuis une page — n'arrive pas dans le
// terminal entre apostrophes.
{
  check("**l'arbre pose un type qui lui appartient**", dropped.ZYVRO_PATH === "application/x-zyvro-path", dropped.ZYVRO_PATH)
  check(
    "un chemin par ligne",
    JSON.stringify(dropped.pathsFromText("/a/un\n/a/deux\n")) === '["/a/un","/a/deux"]',
    JSON.stringify(dropped.pathsFromText("/a/un\n/a/deux\n"))
  )
  check("les lignes vides ne comptent pas", dropped.pathsFromText("\n\n").length === 0)
  check("et rien du tout ne casse rien", dropped.pathsFromText(undefined).length === 0)

  // La lecture d'un dépôt vit dans le rendu — elle touche au DOM — mais les
  // deux panneaux doivent passer par elle : celui qui lirait `dataTransfer`
  // lui-même n'accepterait qu'une des deux sources, et ce serait l'autre que la
  // personne essaierait.
  for (const rel of ["src/renderer/panels/AgentPanel.tsx", "src/renderer/panels/TerminalPanel.tsx"]) {
    const source = readFileSync(path.join(ROOT, rel), "utf8")
    check(`${path.basename(rel)} lit les deux sources par la même fonction`, source.includes("droppedPaths(event)"))
    check(`${path.basename(rel)} ne relit pas les types lui-même`, !source.includes('dataTransfer.types].includes("Files")'))
  }
  const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
  check("**l'arbre se laisse attraper**", explorer.includes("draggable={Boolean(root)}"))
  check("et pose aussi un text/plain, pour le reste du monde", explorer.includes('setData("text/plain"'))
  // Absolu, parce qu'un shell et un agent ne savent pas d'où l'arbre compte
  // ses chemins : il parle en relatif au projet.
  check(
    "**et il pose un chemin absolu**",
    explorer.includes("${root") && explorer.includes("${entry.path}"),
    "le chemin déposé a l'air relatif"
  )
}

// ---- le chemin d'un fichier déposé ---------------------------------------
//
// Il n'existe qu'une façon de l'obtenir, et ce n'est plus celle que tout le
// monde connaît : lire `File.path` rend `undefined` depuis Electron 32, sans
// erreur et sans rien dire.
{
  const preload = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8")
  check("**le chemin vient de webUtils**", preload.includes("webUtils.getPathForFile"))

  const renderer = ["src/renderer/panels/AgentPanel.tsx", "src/renderer/panels/TerminalPanel.tsx"]
    .map((rel) => readFileSync(path.join(ROOT, rel), "utf8"))
    .join("\n")
  check(
    "**et personne ne lit `file.path`**",
    !/\bfile\.path\b/.test(renderer),
    "un panneau lit file.path, qui n'existe plus"
  )
  // Les deux panneaux écrivent le même texte parce qu'ils appellent la même
  // fonction. Deux citations écrites séparément, c'est une qui se trompe.
  for (const rel of ["src/renderer/panels/AgentPanel.tsx", "src/renderer/panels/TerminalPanel.tsx"]) {
    const source = readFileSync(path.join(ROOT, rel), "utf8")
    check(`${path.basename(rel)} cite par la fonction partagée`, source.includes("droppedText("))
  }
}

console.log(
  failures === 0
    ? "\nUn fichier lâché écrit son chemin, cité, là où était le curseur."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
