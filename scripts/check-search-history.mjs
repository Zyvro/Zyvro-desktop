// Les recherches précédentes.
//
// Ce qui casse en silence ici :
//
// 1. **Un historique de préfixes.** La recherche part toute seule après un
//    silence ; si chacune se retenait, la liste contiendrait « w », « wo »,
//    « wor » et pas une seule recherche entière. On ne retient que ce que la
//    personne valide.
//
// 2. **Un historique qui déborde d'un projet à l'autre.** Les mots qu'on
//    cherche sont ceux du dépôt ouvert.
//
// 3. **Un stockage abîmé.** Ce qui est relu vient d'un endroit que n'importe
//    quoi peut écrire : du contenu qui n'est pas une liste de chaînes ne doit
//    pas faire tomber le panneau.
//
//     node scripts/check-search-history.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-history-check")
mkdirSync(dir, { recursive: true })

writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/renderer/state/searchHistory").replace(/\\/g, "/")}"\n`
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

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  },
}

const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const A = "/tmp/projet-a"
const B = "/tmp/projet-b"

check("**au départ, rien**", mod.history(A).length === 0)

{
  let woken = 0
  const stop = mod.subscribeHistory(() => woken++)
  mod.remember(A, "workflow")
  mod.remember(A, "provider")
  check("**la dernière recherche est en tête**", mod.history(A)[0] === "provider", JSON.stringify(mod.history(A)))
  check("et la précédente juste derrière", mod.history(A)[1] === "workflow")
  check("le panneau est réveillé à chaque fois", woken === 2, String(woken))
  stop()
}

// Chercher deux fois la même chose ne doit pas la mettre deux fois dans la
// liste — c'est ce qui la rend inutilisable au bout d'une heure.
mod.remember(A, "workflow")
check("**une recherche répétée remonte au lieu de se dédoubler**", JSON.stringify(mod.history(A)) === '["workflow","provider"]', JSON.stringify(mod.history(A)))

mod.remember(A, "   ")
check("le vide ne se retient pas", mod.history(A).length === 2)
mod.remember(A, "  spacieux  ")
check("et ce qu'on retient est débarrassé de ses espaces", mod.history(A)[0] === "spacieux")

check("**le projet d'à côté a le sien**", mod.history(B).length === 0)
mod.remember(B, "autre chose")
check("chacun le sien", mod.history(A)[0] === "spacieux" && mod.history(B)[0] === "autre chose")

// Vingt, et pas plus : au-delà on ne remonte plus une liste, on cherche dedans.
{
  const C = "/tmp/projet-c"
  for (let i = 0; i < 30; i++) mod.remember(C, `terme ${i}`)
  check("**la liste ne grandit pas sans fin**", mod.history(C).length === 20, String(mod.history(C).length))
  check("et c'est la fin qu'on garde", mod.history(C)[0] === "terme 29")
}

// Ce qui est relu vient d'un endroit que n'importe quoi peut écrire.
{
  const D = "/tmp/projet-d"
  store.set(`zyvro.search.history:${D}`, "{ ceci n'est pas une liste")
  check("**un stockage abîmé ne fait pas tomber le panneau**", mod.history(D).length === 0)

  const E = "/tmp/projet-e"
  store.set(`zyvro.search.history:${E}`, JSON.stringify(["bon", 42, null, "aussi bon"]))
  check("et ce qui n'est pas une chaîne est jeté", JSON.stringify(mod.history(E)) === '["bon","aussi bon"]', JSON.stringify(mod.history(E)))
}

console.log(
  failures === 0
    ? "\nLes recherches précédentes reviennent, sans doublon, sans déborder d'un projet à l'autre."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
