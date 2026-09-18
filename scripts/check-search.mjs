// Chercher dans un projet, et remplacer.
//
// Ce qui casse en silence ici :
//
// 1. **Un remplacement qui écrit autre chose que ce qu'on a vu.** La liste des
//    résultats est une photo : le fichier peut avoir changé depuis. Remplacer
//    aux coordonnées d'une photo périmée mange la ligne d'à côté, dans des
//    fichiers qu'on n'a pas ouverts, et personne ne le voit passer.
//
// 2. **Les trois boutons.** Sans `i`, une recherche ordinaire ne trouve rien ;
//    sans `\b`, « mot entier » trouve `import` dans `important` ; en mode
//    ordinaire, un point doit être un point et pas « n'importe quel
//    caractère ».
//
// 3. **Le dossier qu'on ne doit pas traverser.** `node_modules` fait perdre une
//    minute et noie la liste. Un fichier binaire y ajoute des lignes illisibles.
//
// 4. **Un motif qui accepte le vide** — `a*` — fait tourner la recherche sans
//    fin sur la même position.
//
//     node scripts/check-search.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-search-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/main/search").replace(/\\/g, "/")}"\n`
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
const search = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Un projet pour de vrai, sur le disque : la recherche lit des fichiers, et un
// faux système de fichiers ne dirait rien de ce qui casse.
const project = path.join(tmpdir(), "zyvro-search-check")
function plant(files) {
  rmSync(project, { recursive: true, force: true })
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(project, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

plant({
  "src/a.ts": 'import { thing } from "./b"\nconst something = thing\nconsole.log(Thing)\n',
  "src/b.ts": "export const thing = 1\n",
  "notes/readme.md": "A thing, and another thing.\n",
  "node_modules/dep/index.js": "const thing = 'should never be found'\n",
  "assets/logo.png": "\u0000\u0001thing\u0000",
})

// ---- ce qu'on trouve -----------------------------------------------------
{
  const out = await search.search(project, { query: "thing" })
  const paths = out.files.map((f) => f.path).sort()
  check("**on trouve dans tout le projet**", out.matches > 0, JSON.stringify(paths))
  check(
    "**node_modules n'est pas traversé**",
    !paths.some((p) => p.includes("node_modules")),
    paths.join(", ")
  )
  check("un fichier binaire n'est pas lu comme du texte", !paths.some((p) => p.endsWith(".png")), paths.join(", "))
  check("sans « Aa », on trouve aussi les majuscules", out.files.some((f) => f.matches.some((m) => m.text.includes("Thing"))))

  const first = out.files.find((f) => f.path === "src/a.ts")
  const hit = first.matches[0]
  check(
    "chaque résultat porte sa ligne, sa colonne et sa longueur",
    hit.line === 0 && hit.length === 5 && "src/a.ts".length > 0,
    JSON.stringify(hit)
  )
  check("et la ligne entière, pour l'afficher", hit.text.includes("import"))
}

// ---- les trois boutons ---------------------------------------------------
{
  const sensitive = await search.search(project, { query: "Thing", matchCase: true })
  check(
    "**« Aa » distingue les majuscules**",
    sensitive.matches === 1 && sensitive.files[0].matches[0].text.includes("Thing"),
    String(sensitive.matches)
  )

  // `something` contient `thing` : c'est exactement ce que « mot entier » doit
  // refuser, et ce qu'on ne voit pas quand le fixture ne contient pas le piège.
  const loose = await search.search(project, { query: "thing" })
  const whole = await search.search(project, { query: "thing", wholeWord: true })
  check(
    "**« ab » ne trouve pas un mot dans un autre**",
    loose.matches > whole.matches,
    `${loose.matches} sans, ${whole.matches} avec`
  )
  const insideWord = whole.files
    .flatMap((f) => f.matches)
    .some((m) => m.text.slice(Math.max(0, m.column - 4), m.column).endsWith("some"))
  check("et surtout, pas celui qui est dans « something »", !insideWord)

  const dot = await search.search(project, { query: "a.ts" })
  check("**en mode ordinaire, un point est un point**", dot.matches === 0, String(dot.matches))

  const rx = await search.search(project, { query: "th(i)ng", regex: true })
  check("en mode expression, il est un motif", rx.matches > 0)

  const bad = await search.search(project, { query: "th(", regex: true }).then(() => null, (e) => e)
  check("**une expression invalide le dit au lieu de ne rien trouver**", bad instanceof Error, String(bad))

  // Un motif qui accepte le vide bouclerait sans fin sur la même position.
  const empty = await Promise.race([
    search.search(project, { query: "x*", regex: true }),
    new Promise((resolve) => setTimeout(() => resolve("bloqué"), 4000)),
  ])
  check("**un motif qui accepte le vide ne bloque pas**", empty !== "bloqué")
}

// ---- où chercher ---------------------------------------------------------
{
  const only = await search.search(project, { query: "thing", include: "*.md" })
  check("**« include » restreint aux fichiers nommés**", only.files.every((f) => f.path.endsWith(".md")), JSON.stringify(only.files.map((f) => f.path)))
  check("et il regarde dans les sous-dossiers", only.files.some((f) => f.path === "notes/readme.md"))

  const without = await search.search(project, { query: "thing", exclude: "notes/**" })
  check("**« exclude » écarte un dossier**", !without.files.some((f) => f.path.startsWith("notes/")))

  check("un motif avec un dossier vise le chemin", search.globToRegExp("src/**").test("src/a.ts"))
  check("et un motif sans dossier vise le nom", search.globToRegExp("*.ts").test("deep/nested/a.ts"))
}

// ---- chercher dans un dossier -------------------------------------------
//
// « Find in folder… » du clic droit. Une portée, et pas un motif d'inclusion de
// plus : `include` est une liste séparée par des virgules dont les `*` comptent,
// donc un dossier littéral qu'on y colle se casse sur le nom que personne ne
// teste — et se casse en silence, en cherchant ailleurs.
{
  plant({
    "src/a.ts": "const thing = 1\n",
    "notes/readme.md": "a thing\n",
    "notes/deep/inside.md": "a thing\n",
    "Notes, old/kept.md": "a thing\n",
    "old/elsewhere.md": "a thing\n",
    "node_modules/dep/index.js": "thing\n",
  })

  const dedans = await search.search(project, { query: "thing", scope: "notes" })
  const chemins = dedans.files.map((f) => f.path).sort()
  check(
    "**la portée ne rend que ce dossier**",
    chemins.length === 2 && chemins.every((p) => p.startsWith("notes/")),
    chemins.join(", ")
  )
  check("et ses sous-dossiers", chemins.includes("notes/deep/inside.md"), chemins.join(", "))

  // Le nom qui casse un motif d'inclusion. `Notes, old/**` serait lu comme deux
  // motifs — `Notes` et `old/**` — et trouverait `old/elsewhere.md`, qui est un
  // autre dossier. Une portée est un chemin, pas un motif.
  const virgule = await search.search(project, { query: "thing", scope: "Notes, old" })
  const vus = virgule.files.map((f) => f.path).sort()
  check(
    "**un dossier dont le nom a une virgule reste un seul dossier**",
    vus.length === 1 && vus[0] === "Notes, old/kept.md",
    vus.join(", ")
  )

  // La portée s'ajoute aux filtres, elle ne les remplace pas.
  const croise = await search.search(project, { query: "thing", scope: "notes", include: "*.md" })
  check("elle se combine avec « include »", croise.files.every((f) => f.path.startsWith("notes/") && f.path.endsWith(".md")))

  check("« . » veut dire tout le projet", (await search.search(project, { query: "thing", scope: "." })).files.length > 3)
  check("une barre de trop ne change rien", (await search.search(project, { query: "thing", scope: "/notes/" })).files.length === 2)

  // Zéro résultat se lit « le texte n'y est pas ». Une portée qui n'est pas un
  // dossier doit donc le dire, pas rendre une liste vide.
  const refuse = async (scope) => {
    try {
      await search.search(project, { query: "thing", scope })
      return null
    } catch (err) {
      return err.message
    }
  }
  check("**une portée qui n'existe pas est dite, pas avalée**", (await refuse("nulle-part")) !== null)
  check("**un fichier n'est pas un dossier où chercher**", (await refuse("src/a.ts")) !== null)
  check("et une portée hors du projet est refusée", (await refuse("../..")) !== null)

  // Remplacer suit la portée de ce qui est affiché : remplacer plus large que
  // ce qu'on a montré est exactement ce qu'on ne peut pas rattraper.
  const done = await search.replaceAll(project, { query: "thing", scope: "notes" }, "widget")
  check("**remplacer tout ne sort pas de la portée**", done.files === 2, JSON.stringify(done))
  check(
    "et le dossier voisin est intact",
    readFileSync(path.join(project, "old/elsewhere.md"), "utf8").includes("thing"),
    readFileSync(path.join(project, "old/elsewhere.md"), "utf8")
  )
}

// ---- remplacer tout ------------------------------------------------------
{
  plant({ "a.txt": "thing thing\n", "b.txt": "a thing here\n" })
  const done = await search.replaceAll(project, { query: "thing" }, "widget")
  check("**tout est remplacé, partout**", done.matches === 3 && done.files === 2, JSON.stringify(done))
  check("et le fichier contient le résultat", readFileSync(path.join(project, "a.txt"), "utf8") === "widget widget\n")
  check("sans perdre la fin de ligne", readFileSync(path.join(project, "b.txt"), "utf8").endsWith("\n"))
}

// ---- remplacer une occurrence -------------------------------------------
{
  plant({ "a.txt": "thing thing thing\n" })
  const found = await search.search(project, { query: "thing" })
  const second = found.files[0].matches[1]
  const done = await search.replaceAll(project, { query: "thing" }, "widget", [{ path: "a.txt", ...second }])
  check("**une seule occurrence, celle qu'on a désignée**", done.matches === 1, JSON.stringify(done))
  check(
    "et c'est bien la deuxième",
    readFileSync(path.join(project, "a.txt"), "utf8") === "thing widget thing\n",
    readFileSync(path.join(project, "a.txt"), "utf8")
  )
}

// ---- le fichier a changé depuis ------------------------------------------
{
  plant({ "a.txt": "thing thing thing\n" })
  const found = await search.search(project, { query: "thing" })
  const third = found.files[0].matches[2]
  // Quelqu'un — un agent, un autre éditeur, soi-même — réécrit le fichier entre
  // la recherche et le remplacement.
  writeFileSync(path.join(project, "a.txt"), "completely different\n")
  const done = await search.replaceAll(project, { query: "thing" }, "widget", [{ path: "a.txt", ...third }])
  check("**un passage qui a bougé est refusé, pas remplacé à l'aveugle**", done.matches === 0 && done.skipped === 1, JSON.stringify(done))
  check(
    "et le fichier est intact",
    readFileSync(path.join(project, "a.txt"), "utf8") === "completely different\n",
    readFileSync(path.join(project, "a.txt"), "utf8")
  )
}

// ---- les groupes d'une expression ---------------------------------------
{
  plant({ "a.ts": 'import { a } from "./old/path"\n' })
  await search.replaceAll(project, { query: '"\\./old/(\\w+)"', regex: true }, '"./new/$1"')
  check(
    "**en mode expression, $1 vaut le groupe**",
    readFileSync(path.join(project, "a.ts"), "utf8").includes('"./new/path"'),
    readFileSync(path.join(project, "a.ts"), "utf8")
  )

  // En mode ordinaire, un dollar est un dollar : le remplacement est littéral.
  plant({ "b.txt": "price\n" })
  await search.replaceAll(project, { query: "price" }, "$1 dollars")
  check("**en mode ordinaire, $1 est du texte**", readFileSync(path.join(project, "b.txt"), "utf8") === "$1 dollars\n")
}

// ---- un fichier entier, d'un coup ---------------------------------------
//
// Entre « celle que je regarde » et « les quatre-vingt-quatorze », il y a le cas
// de tous les jours : ce fichier-ci. Le panneau l'obtient en désignant toutes
// les occurrences d'un fichier — donc c'est la même route, et ce qu'on vérifie
// est qu'elle ne déborde pas sur le voisin.
{
  plant({ "a.txt": "thing thing\n", "b.txt": "thing\n" })
  const found = await search.search(project, { query: "thing" })
  const one = found.files.find((f) => f.path === "a.txt")
  const done = await search.replaceAll(
    project,
    { query: "thing" },
    "widget",
    one.matches.map((m) => ({ path: "a.txt", line: m.line, column: m.column, length: m.length }))
  )
  check("**tout le fichier désigné, et lui seul**", done.files === 1 && done.matches === 2, JSON.stringify(done))
  check("le fichier visé est réécrit", readFileSync(path.join(project, "a.txt"), "utf8") === "widget widget\n")
  check("**et le voisin est intact**", readFileSync(path.join(project, "b.txt"), "utf8") === "thing\n")
}

rmSync(project, { recursive: true, force: true })
console.log(
  failures === 0
    ? "\nLa recherche trouve ce qu'on lui demande, et le remplacement n'écrit que ce qu'on a vu."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
