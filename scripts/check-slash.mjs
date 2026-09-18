// Les commandes en barre oblique.
//
// Elles marchent déjà : ce qu'on tape part sur l'entrée standard et la CLI les
// exécute. Vérifié plutôt que supposé — `claude -p "/context"` rend le vrai
// rapport de contexte, pas le modèle qui parle du mot. Ce qui manquait n'était
// donc pas l'exécution mais de savoir qu'elles existent : claude en annonce 107
// sur cette machine, greffons compris, et rien ne les montrait.
//
// Ce qui casse en silence ici :
//
// 1. **Une liste écrite chez nous serait fausse.** Elle vient du harnais ET de
//    ses greffons, qui changent sans nous prévenir. La seule source honnête est
//    ce que la CLI annonce dans son événement `init`.
//
// 2. **Entrée doit compléter, pas envoyer.** Envoyer `/lo` à la CLI, c'est une
//    commande inconnue et un tour perdu — payé, pour rien.
//
// 3. **Un chemin n'est pas une commande.** On dépose des fichiers dans cette
//    boîte : `/tmp/capture.png` commence par une barre oblique et n'a rien à
//    faire dans un menu de commandes.
//
//     node scripts/check-slash.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-slash-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
const maison = path.join(os.tmpdir(), `zyvro-slash-${process.pid}`)
mkdirSync(maison, { recursive: true })
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(maison)} } }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { commandsIn, known, remember } from "${from("src/main/commands")}"\n` +
    `export { matching, slashPrefix } from "${from("src/renderer/state/commands")}"\n`
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
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- la liste vient du harnais -------------------------------------------
{
  // L'événement réel, relevé sur les deux CLI : c'est `system/init` qui porte
  // `slash_commands`.
  const init = { type: "system", subtype: "init", session_id: "s1", slash_commands: ["loop", "goal", "clear"] }
  check("**la liste se lit sur l'événement init**", JSON.stringify(mod.commandsIn(init)) === '["loop","goal","clear"]')

  // Un autre événement n'en porte pas, et en inventer une serait pire que rien.
  check("un autre événement n'en porte pas", mod.commandsIn({ type: "assistant", slash_commands: ["x"] }) === null)
  check("ni un init sans liste", mod.commandsIn({ type: "system", subtype: "init" }) === null)

  // Certaines CLI les annoncent avec la barre, d'autres sans : le menu la met
  // lui-même, donc elle est retirée à la lecture. Sans ça, « //loop ».
  const melange = { type: "system", subtype: "init", slash_commands: ["/loop", "goal", "", 42, "  clear  "] }
  check(
    "**la barre est retirée et le bruit écarté**",
    JSON.stringify(mod.commandsIn(melange)) === '["loop","goal","clear"]',
    JSON.stringify(mod.commandsIn(melange))
  )

  // Elle est gardée : la liste n'arrive qu'avec un tour, et le moment où l'on
  // cherche ce qu'on peut taper est celui d'avant.
  check("rien n'est connu avant qu'un harnais ait parlé", mod.known("claude").length === 0)
  check("**ce qu'il annonce est retenu**", mod.remember("claude", ["loop", "goal"]) === true)
  check("et relu", JSON.stringify(mod.known("claude")) === '["loop","goal"]')
  // Réannoncer la même chose ne doit pas réveiller la fenêtre pour rien.
  check("**réannoncer la même liste ne change rien**", mod.remember("claude", ["loop", "goal"]) === false)
  check("une liste différente, si", mod.remember("claude", ["loop"]) === true)
  // Chaque harnais la sienne : claude en a 107 ici, qwen 27, et les mélanger
  // proposerait des commandes que l'autre ne connaît pas.
  check("**chaque harnais garde la sienne**", mod.known("qwen").length === 0 && mod.known("claude").length === 1)

  // Et personne n'écrit de liste dans ce dépôt.
  const source = readFileSync(path.join(ROOT, "src/renderer/state/commands.ts"), "utf8")
  check(
    "**aucune liste de commandes n'est écrite ici**",
    !/"(loop|goal|clear|compress)"/.test(source),
    "une liste de commandes est codée en dur"
  )
}

// ---- ce qu'on est en train de taper --------------------------------------
{
  const p = (texte, curseur = texte.length) => mod.slashPrefix(texte, curseur)
  check("**`/lo` propose de compléter**", p("/lo") === "lo")
  check("une barre seule propose tout", p("/") === "")
  check("un message ordinaire, non", p("bonjour") === null)

  // On dépose des fichiers dans cette boîte : un chemin commence par une barre
  // oblique et n'est pas une commande.
  check("**un chemin déposé n'est pas une commande**", p("/tmp/capture.png") === null)
  check("ni un chemin au milieu d'une phrase", p("regarde /tmp/a.png") === null)

  // Et on ne complète plus dès qu'on est reparti écrire ailleurs.
  check("**le curseur doit être dans le mot**", p("/loop fais un tour", 3) === null)
  check("une commande suivie d'un argument ne propose plus", p("/loop fais un tour") === null)

  // Les greffons portent des noms à deux-points — `vercel:deploy` — et les
  // écarter reviendrait à cacher les trois quarts des 107.
  check("**un nom de greffon reste complétable**", p("/vercel:dep") === "vercel:dep")
}

// ---- ce que le menu propose ----------------------------------------------
{
  const toutes = ["clear", "compress", "context", "loop", "goal", "vercel:deploy"]
  check("**par le début, pas n'importe où**", JSON.stringify(mod.matching(toutes, "co")) === '["compress","context"]')
  check("insensible à la casse", mod.matching(toutes, "CO").length === 2)
  check("rien de tapé propose tout", mod.matching(toutes, "").length === toutes.length)
  check("un préfixe inconnu ne propose rien", mod.matching(toutes, "zzz").length === 0)
  // L'ordre est celui du harnais : il range ses propres commandes avant celles
  // de ses greffons, et trier alphabétiquement noierait `clear` au milieu de
  // quatre-vingts noms de greffons.
  check(
    "**et l'ordre reste celui du harnais**",
    JSON.stringify(mod.matching(toutes, "")) === JSON.stringify(toutes),
    "le menu réordonne ce que le harnais avait rangé"
  )
}

// ---- entrée complète, elle n'envoie pas -----------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const clavier = panel.slice(panel.indexOf("const onKeyDown"), panel.indexOf("const useExample"))
  check(
    "**tant que le menu est ouvert, Entrée complète**",
    /if \(menuOuvert\)/.test(clavier) && /completer\(proposees\[surligne\]\)/.test(clavier),
    "Entrée envoie une commande à moitié tapée : un tour payé pour rien"
  )
  check("Tab aussi", /event\.key === "Tab"/.test(clavier))
  // `/goal` est un nom entier autant qu'un préfixe de lui-même. Compléter n'y
  // changerait rien et mangerait la touche : la commande ne partirait jamais.
  // Vu en l'essayant, pas en relisant.
  check(
    "**mais une commande déjà entière part au lieu d'être « complétée »**",
    /!dejaComplet/.test(clavier),
    "Entrée mange la touche sur une commande complète : elle ne part jamais"
  )
  check("les flèches parcourent", /ArrowDown/.test(clavier) && /ArrowUp/.test(clavier))
  check("et Échap ferme sans effacer", /event\.key === "Escape"/.test(clavier) && !/setDraft\(""\)/.test(clavier))
}

console.log(
  failures === 0
    ? "\nLes commandes du harnais se proposent, et Entrée les complète au lieu de les envoyer à moitié."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
