// Un jeton ne se prend pas pendant le rendu.
//
// Trois magasins de module servent de boîte à lettres entre deux panneaux qui
// ne sont pas le même composant : `handoff` (un chemin déposé dans le champ de
// l'agent, un dossier déposé dans la recherche, un `cd` déposé dans le shell)
// et `persistent` (« ouvre cette session »). Chacun se lit une fois : on
// **prend**, on ne lit pas, sans quoi le rendu suivant referait le geste.
//
// Et prendre est précisément ce qu'un rendu n'a pas le droit de faire. React en
// développement rend chaque composant DEUX fois et jette le premier passage :
// le jeton était consommé par le passage jeté, et ses mises à jour partaient
// avec lui. En production, où le double rendu n'existe pas, tout marchait — la
// pire façon pour un défaut de se cacher, et c'est celle-ci qui a coûté à
// Jeremy un « je mets un nom et il ne se passe rien » que trois essais en
// production n'ont pas su reproduire.
//
// La règle tient en une ligne : le repère change pendant le rendu — c'est une
// écriture idempotente — et la prise attend `queueMicrotask`, où elle est
// rejouable puisqu'un second appel rend `null`.
//
//     node scripts/check-token-take.mjs
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) yield* sources(full)
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) yield full
  }
}

// Les fonctions qui consomment : leur nom dit qu'elles prennent.
const TAKERS = /\b(takeHandoff|takeOpen)\(/

let failures = 0
let sites = 0
for (const file of sources(path.join(ROOT, "src/renderer"))) {
  const brut = readFileSync(file, "utf8")
  // Par le nom, séparateur ramené à `/` : sous Windows `file` finit par
  // `\handoff.ts`, et la définition elle-même était prise pour un appel.
  const posix = file.split(path.sep).join("/")
  if (posix.endsWith("/handoff.ts") || posix.endsWith("/persistent.ts")) continue
  // Les commentaires sont blanchis plutôt que retirés, pour que les numéros de
  // ligne restent justes. Sans ça ce garde s'attrapait lui-même : la phrase qui
  // explique la règle cite `takeOpen()`, et une citation n'est pas un appel.
  const text = brut
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
  for (const m of text.matchAll(new RegExp(TAKERS, "g"))) {
    sites++
    // La règle, dite simplement : entre l'ouverture du `queueMicrotask` et la
    // prise, il ne doit pas y avoir d'accolade fermante — autrement dit la
    // prise est dans ce bloc-là et pas dans un bloc voisin.
    //
    // Deux versions plus savantes ont précédé celle-ci, et toutes deux
    // disaient « ok » quoi qu'il arrive : compter les accolades à rebours dans
    // du JSX revient à compter celles des `className={…}`, des littéraux et
    // des expressions régulières. Un garde qui ne peut pas échouer ne garde
    // rien — c'est vérifié en le cassant aux quatre endroits.
    const fenetre = text.slice(Math.max(0, m.index - 300), m.index)
    const ouverture = fenetre.lastIndexOf("queueMicrotask(")
    const fermeture = fenetre.lastIndexOf("}")
    const dedans = ouverture >= 0 && ouverture > fermeture
    if (dedans) continue
    const ligne = text.slice(0, m.index).split("\n").length
    console.log(
      `  FAIL  ${path.relative(ROOT, file)}:${ligne} prend un jeton pendant le rendu` +
        `\n        en développement React rend deux fois et jette le premier passage :` +
        ` le jeton part avec lui et le geste ne se fait jamais` +
        `\n        remettre l'appel dans window.queueMicrotask(() => { … })`
    )
    failures++
  }
}

console.log(
  failures === 0
    ? `  ok    les ${sites} prises de jeton attendent la fin du rendu\n\nCe qu'on dépose dans une boîte à lettres arrive, en développement comme en production.`
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
