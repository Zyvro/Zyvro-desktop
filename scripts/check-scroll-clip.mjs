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
// Le garde ne juge pas du goût ; il attrape les combinaisons de classes dont le
// résultat est toujours une partie de l'interface qu'on ne peut pas lire.
//
// La seconde est arrivée par le même chemin : « le select de model sort de la
// fenêtre en bas, j'ai beaucoup de model ». Un menu Radix se dimensionne sur
// son contenu, et un contenu construit par `.map()` n'a pas de longueur connue
// — quatre alias de CLI hier, trente modèles de serveurs locaux aujourd'hui. Il
// pousse alors hors de la fenêtre, et ce qui en sort est inatteignable, y
// compris la dernière ligne qui sert à taper un nom à la main. Radix mesure la
// place disponible et la publie ; encore faut-il s'en servir.
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

if (failures === 0) console.log(`  ok    aucun conteneur ne centre verticalement ce qui déborde (${scanned} fichiers)`)

// ---- un menu qui liste sans plafond --------------------------------------
//
// Ce qu'on cherche : un `<Menu.Content>` dont le corps contient un `.map(`,
// c'est-à-dire une liste dont personne ne connaît la longueur, et dont les
// classes ne portent aucun plafond de hauteur.
//
// `max-h-[var(--radix-…-available-height)]` est la réponse de Radix : il mesure
// ce qu'il reste entre le déclencheur et le bord, des deux côtés, et le publie
// en variable CSS. Un `max-h-[420px]` écrit à la main compte aussi — c'est un
// plafond, même s'il ignore la taille de la fenêtre.
const PLAFOND = /max-h-\[/
let menus = 0
for (const file of dirs.flatMap((d) => [...sources(d)])) {
  const text = readFileSync(file, "utf8")
  for (const m of text.matchAll(/<Menu\.Content\b/g)) {
    const fin = text.indexOf("</Menu.Content>", m.index)
    const bloc = text.slice(m.index, fin === -1 ? m.index + 2000 : fin)
    // Les attributs du composant, jusqu'au premier `>` de la balise ouvrante.
    const balise = bloc.slice(0, bloc.indexOf(">") + 1)
    menus++
    if (!/\.map\(/.test(bloc)) continue
    if (PLAFOND.test(balise)) continue
    // Les classes peuvent venir d'une constante du fichier — `className={panel}`
    // ou `` className={`${panel} …`} ``. La suivre, sinon le garde réclamerait
    // d'écrire le plafond en double à l'endroit précis où il est partagé.
    const via = [...balise.matchAll(/\$?\{\s*([A-Za-z_$][\w$]*)/g)].map((v) => v[1])
    if (
      via.some((nom) => {
        const decl = text.match(new RegExp(`const ${nom}\\s*=\\s*([\\s\\S]{0,400}?)\n\n`))
        return decl ? PLAFOND.test(decl[1]) : false
      })
    )
      continue
    const ligne = text.slice(0, m.index).split("\n").length
    console.log(
      `  FAIL  ${path.relative(ROOT, file)}:${ligne} liste sans plafond de hauteur` +
        `\n        un menu se dimensionne sur son contenu : trente entrées le poussent hors de la fenêtre,` +
        `\n        et ce qui en sort est inatteignable. max-h-[var(--radix-dropdown-menu-content-available-height)]`
    )
    failures++
  }
}
if (failures === 0) console.log(`  ok    aucun menu ne liste sans plafond (${menus} menus)`)

console.log(
  failures === 0
    ? `\nCe qui défile commence par son début, et ce qui liste tient dans la fenêtre.`
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
