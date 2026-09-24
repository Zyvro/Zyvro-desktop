// Un arbre de fichiers qui ne ralentit pas sur un gros dossier.
//
// « Quand j'ouvre des dossiers énormes comme […]/assets/gfx cela lag. » Mesuré
// sur un dossier de 28 561 entrées, avant : **12 721 ms** pour l'ouvrir, 28 626
// boutons et 171 851 nœuds dans le DOM, et trente-deux images en douze
// secondes — deux images et demie par seconde, c'est-à-dire figé.
//
// Deux causes, et la première était de mon fait :
//
// 1. **Un menu contextuel par ligne**, ajouté la veille. Vingt-huit mille
//    menus repliés dans le DOM, alors qu'un menu contextuel ne peut être ouvert
//    qu'à un endroit à la fois.
//
// 2. **Tout était dessiné.** Un arbre de composants récursifs ne se virtualise
//    pas : chaque nœud décide de ses enfants, donc personne ne sait combien il
//    y a de lignes ni où commence la centième. D'où la liste à plat.
//
// Après : **307 ms**, 84 boutons, 570 nœuds.
//
// Ce qui casse en silence ici :
//
// **La hauteur de ligne.** C'est elle qui place chaque ligne sans mesurer quoi
// que ce soit. Se tromper d'un pixel, et l'ascenseur dérive de vingt-huit mille
// pixels au bas d'un gros dossier.
//
// **La requête d'un dossier ouvert hors cadre.** Elle vivait dans la ligne ; une
// ligne qu'on ne dessine plus emporterait sa requête, et l'arbre se replierait
// en défilant.
//
//     node scripts/check-tree.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-tree-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { aplatir, ROW_HEIGHT, OVERSCAN } from "${path.join(ROOT, "src/renderer/panels/Explorer").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  alias: { "@": path.join(ROOT, "../Zyvro-frontend/src"), "~": path.join(ROOT, "src/renderer") },
  define: { "process.env.NEXT_PUBLIC_API_URL": '"http://127.0.0.1:0"' },
  absWorkingDir: ROOT, logLevel: "silent",
  // Les icônes de fichiers passent par `import.meta.glob`, que seul Vite sait
  // lire, et par Monaco : ni l'un ni l'autre n'a sa place dans une
  // vérification de la liste à plat. Une icône vide les remplace ici.
  plugins: [{
    name: "icones-vides",
    setup(b) {
      b.onResolve({ filter: /lib\/fileIcons$/ }, () => ({ path: "fileIcons", namespace: "vide" }))
      b.onLoad({ filter: /.*/, namespace: "vide" }, () => ({
        contents: "export const FileTypeIcon = () => null",
        loader: "js",
      }))
    },
  }],
})
const { aplatir, ROW_HEIGHT, OVERSCAN } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
const files = readFileSync(path.join(ROOT, "src/main/files.ts"), "utf8")

const dossier = (nom, chemin) => ({ name: nom, path: chemin, kind: "directory" })
const fichier = (nom, chemin) => ({ name: nom, path: chemin, kind: "file" })

// ---- l'arbre ouvert devient une liste ------------------------------------
{
  const parDossier = new Map([
    [".", [dossier("src", "src"), fichier("README.md", "README.md")]],
    ["src", [dossier("lib", "src/lib"), fichier("index.ts", "src/index.ts")]],
    ["src/lib", [fichier("util.ts", "src/lib/util.ts")]],
  ])

  const rien = []
  aplatir(parDossier, new Set(), ".", 0, rien)
  check("**replié, on ne voit que la racine**", rien.map((l) => l.entry.name).join(",") === "src,README.md")
  check("et tout à la profondeur zéro", rien.every((l) => l.depth === 0))

  const unNiveau = []
  aplatir(parDossier, new Set(["src"]), ".", 0, unNiveau)
  check(
    "**un dossier ouvert insère ses enfants sous lui**",
    unNiveau.map((l) => l.entry.name).join(",") === "src,lib,index.ts,README.md",
    unNiveau.map((l) => l.entry.name).join(",")
  )
  check("à la profondeur suivante", unNiveau[1].depth === 1 && unNiveau[3].depth === 0)

  const deux = []
  aplatir(parDossier, new Set(["src", "src/lib"]), ".", 0, deux)
  check(
    "**et deux niveaux s'emboîtent dans l'ordre**",
    deux.map((l) => `${l.entry.name}@${l.depth}`).join(",") === "src@0,lib@1,util.ts@2,index.ts@1,README.md@0",
    deux.map((l) => `${l.entry.name}@${l.depth}`).join(",")
  )

  // Un dossier ouvert dont la liste n'est pas encore arrivée n'insère rien, et
  // surtout ne casse rien.
  const pasEncore = []
  aplatir(parDossier, new Set(["src", "src/inconnu"]), ".", 0, pasEncore)
  check("un dossier ouvert sans réponse n'insère rien", pasEncore.length === 4)
  // Un fichier « ouvert » n'a pas d'enfants : l'ensemble des ouverts ne décide
  // pas de ce qui est un dossier.
  const fauxDossier = []
  aplatir(parDossier, new Set(["README.md"]), ".", 0, fauxDossier)
  check("**et un fichier ne s'ouvre pas**", fauxDossier.length === 2)
}

// ---- seules les lignes visibles sont dessinées ---------------------------
{
  check("**la hauteur d'une ligne est fixe**", ROW_HEIGHT === 26, String(ROW_HEIGHT))
  check("et il y a de la marge autour du cadre", OVERSCAN >= 4)

  // La même hauteur sert à placer ET à réserver : deux valeurs, et l'ascenseur
  // dérive de vingt-huit mille pixels au bas d'un gros dossier.
  check(
    "**la même hauteur place les lignes et réserve le vide**",
    explorer.includes("Math.floor(scrollTop / ROW_HEIGHT)") &&
      explorer.includes("paddingTop: premiere * ROW_HEIGHT") &&
      explorer.includes("paddingBottom: (lignes.length - derniere) * ROW_HEIGHT"),
    "la position et l'espace réservé ne viennent pas du même nombre"
  )
  check(
    "**et on ne dessine qu'une tranche**",
    explorer.includes("lignes.slice(premiere, derniere)"),
    "toutes les lignes sont dessinées"
  )
  // Sans lecture du défilement, la tranche ne bouge jamais.
  check("le défilement est écouté", explorer.includes("onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}"))
}

// ---- les requêtes appartiennent à l'arbre, pas aux lignes ----------------
{
  check(
    "**les dossiers ouverts sont interrogés par l'arbre**",
    explorer.includes("useQueries(") && explorer.includes("ouverts.map("),
    "une ligne hors cadre emporterait sa requête : l'arbre se replierait en défilant"
  )
  check("et plus par chaque ligne", !/function Row[\s\S]{0,600}useQuery/.test(explorer))
  check(
    "**un seul menu contextuel pour tout l'arbre**",
    explorer.split("<EntryMenu").length === 2,
    "un menu par ligne : vingt-huit mille menus dans le DOM"
  )
}

// ---- trier vingt-huit mille noms -----------------------------------------
{
  // `localeCompare` avec un objet d'options construit un comparateur NEUF à
  // chaque comparaison : 851 ms contre 21 ms, mesuré, pour le même ordre.
  check(
    "**le comparateur est construit une fois**",
    files.includes("new Intl.Collator(") && files.includes("COLLATOR.compare("),
    "un comparateur par comparaison : quarante fois plus lent"
  )
  // Cherché dans le code, pas dans les commentaires : celui du dessus nomme
  // justement `localeCompare` pour dire pourquoi on ne s'en sert plus, et la
  // première version de ce garde échouait sur sa propre explication. (La
  // deuxième fois que ça m'arrive.)
  const sansCommentaires = files.replace(/\/\/[^\n]*/g, "")
  check(
    "et personne ne le rappelle",
    !/localeCompare\(/.test(sansCommentaires),
    "localeCompare avec options est rappelé quelque part"
  )
}

console.log(
  failures === 0
    ? "\nUn gros dossier s'ouvre sans que tout soit dessiné, et l'ascenseur tombe juste."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
