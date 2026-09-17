// La politique de contenu et ce que la fenêtre charge vraiment.
//
// Ce qui casse en silence ici, et qui a cassé : une directive absente retombe
// sur `default-src`, qui est `'self'`. Le rendu affichait une vidéo produite
// par un nœud — servie par le démon local, sur la même route et le même port
// qu'une image — et `media-src` n'existait pas. Le lecteur s'affichait, restait
// vide, et disait « source not supported » ; la même adresse dans une balise
// `<img>` se chargeait, et le téléchargement marchait aussi puisqu'il passe par
// `fetch`, que `connect-src` autorise. Trois signaux d'accord pour dire que le
// fichier était bon, et la seule directive qui le refusait ne se voyait nulle
// part.
//
// D'où ce garde : ce que le rendu charge et ce que la politique autorise sont
// deux listes, et la seconde ne se relit jamais. Il les compare.
//
//     node scripts/check-csp.mjs
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const html = readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
check("**la fenêtre porte une politique**", Boolean(meta), "aucune balise Content-Security-Policy")
if (!meta) process.exit(1)

const policy = Object.fromEntries(
  meta[1]
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/)
      return [name, values]
    })
)

// Le démon écoute sur la boucle locale, sur un port que personne ne connaît
// avant l'exécution : la politique ne peut nommer que l'hôte.
const LOOPBACK = ["http://127.0.0.1:*", "http://localhost:*"]

// Ce que le rendu charge, et la directive qui en décide. La colonne de droite
// est ce qu'on va chercher dans les sources : une balise qu'on ajoute un jour
// sans toucher à la politique est exactement l'accident d'aujourd'hui.
const NEEDED = [
  { directive: "img-src", tag: "<img", label: "les images" },
  { directive: "media-src", tag: "<video", label: "les vidéos" },
]

function rendererSources(dir = path.join(ROOT, "src/renderer")) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...rendererSources(full))
    else if (/\.(tsx|ts)$/.test(entry)) out.push(readFileSync(full, "utf8"))
  }
  return out
}
// Le rendu du bureau compose avec celui du site : `MediaFrame` et les cartes de
// la boutique vivent là-bas, et c'est cette fenêtre-ci qui les affiche.
function webSources() {
  const web = path.resolve(ROOT, "../Zyvro-frontend/src/components")
  try {
    return readdirSync(web)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => readFileSync(path.join(web, name), "utf8"))
  } catch {
    return []
  }
}
const sources = [...rendererSources(), ...webSources()].join("\n")

for (const { directive, tag, label } of NEEDED) {
  const used = sources.includes(tag)
  if (!used) {
    check(`${label} ne sont pas affichées : rien à autoriser`, true)
    continue
  }
  const values = policy[directive]
  check(
    `**${label} sont affichées, donc \`${directive}\` existe**`,
    Array.isArray(values),
    `la fenêtre rend ${tag}…> et la politique n'a pas de ${directive} : elle retombe sur default-src, qui est 'self'`
  )
  if (!Array.isArray(values)) continue
  for (const origin of LOOPBACK) {
    check(
      `et ${directive} laisse passer ${origin}`,
      values.includes(origin),
      `${directive}: ${values.join(" ")}`
    )
  }
}

// Ce qui doit rester étroit. Un jour quelqu'un élargira une directive pour
// faire marcher quelque chose ; que ce soit celle-là qui le réveille.
check("**les scripts restent à la seule application**", JSON.stringify(policy["script-src"]) === '["\'self\'"]', String(policy["script-src"]))
check("et rien n'est autorisé par défaut au-delà d'elle", JSON.stringify(policy["default-src"]) === '["\'self\'"]', String(policy["default-src"]))

console.log(
  failures === 0
    ? "\nCe que la fenêtre affiche, la politique l'autorise — et rien de plus."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
