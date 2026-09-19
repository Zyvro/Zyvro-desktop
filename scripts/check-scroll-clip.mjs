// Centrer verticalement ce qui défile coupe le haut, et le coupe pour de bon.
//
// Signalé par Jeremy sur l'écran d'accueil : « la page welcome est soit cut sur
// le haut, soit mal affichée ». Elle commençait au milieu d'un paragraphe, sans
// son titre, et aucun défilement ne le ramenait.
//
// Le mécanisme, qui n'a rien d'un cas particulier : sur un conteneur en
// `flex` qui défile, `items-center` centre un contenu plus grand que la boîte,
// donc le fait déborder des DEUX côtés. Le débordement du bas se rattrape en
// défilant ; celui du haut est au-dessus du point de départ, où `scrollTop`
// vaut déjà zéro. Il est simplement inatteignable.
//
// La bonne façon de centrer ce qui peut déborder est `m-auto` sur l'enfant :
// les marges automatiques se partagent la place libre quand il y en a, et ne
// font rien quand il n'y en a pas — ce qui est exactement la différence qui
// manquait.
//
// Le garde ne juge pas du goût ; il attrape une combinaison de classes dont le
// résultat est toujours une partie de l'interface qu'on ne peut pas lire.
//
//     node scripts/check-scroll-clip.mjs
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const dirs = [path.join(ROOT, "src/renderer"), path.resolve(ROOT, "../Zyvro-frontend/src")]

function* sources(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue
      yield* sources(full)
    } else if (name.endsWith(".tsx")) {
      yield full
    }
  }
}

// Une classe qui fait défiler verticalement, et le centrage vertical d'un flex
// en ligne. `flex-col` est hors de cause : là, `items-center` est horizontal.
const SCROLLS = /\boverflow-(?:y-)?auto\b|\boverflow-y-scroll\b/
const CENTRES = /\bitems-center\b/

let failures = 0
let scanned = 0
for (const file of dirs.flatMap((d) => [...sources(d)])) {
  scanned++
  const text = readFileSync(file, "utf8")
  for (const m of text.matchAll(/className="([^"]*)"/g)) {
    const classes = m[1]
    if (!SCROLLS.test(classes) || !CENTRES.test(classes)) continue
    if (/\bflex-col\b/.test(classes)) continue
    // Une boîte dont l'enfant ne peut pas dépasser ne déborde pas : l'image
    // d'un aperçu porte `max-h-full`, et c'est le cas honnête.
    const ligne = text.slice(0, m.index).split("\n").length
    const suite = text.slice(m.index, m.index + 400)
    if (/max-h-full/.test(suite)) continue
    console.log(
      `  FAIL  ${path.relative(ROOT, file)}:${ligne} centre verticalement ce qui défile` +
        `\n        ${classes.slice(0, 100)}` +
        `\n        le haut du contenu passe au-dessus du défilement et devient illisible ;` +
        ` centrer avec m-auto sur l'enfant`
    )
    failures++
  }
}

console.log(
  failures === 0
    ? `  ok    aucun conteneur ne centre verticalement ce qui déborde (${scanned} fichiers)\n\nCe qui défile commence par son début.`
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
