// Les messages qu'on écrit pendant qu'un tour tourne.
//
// Demandé par Jeremy : « il manque la capacité d'envoyer des prompts en attente
// au prochain tour automatiquement ». C'est le moment où l'on a le plus
// d'idées — l'agent travaille, on lit sa réponse, on pense à la suite — et
// jusqu'ici la touche Entrée ne faisait rien : le texte restait dans la boîte.
//
// Ce qui casse en silence ici :
//
// 1. **Une file qui dépense sans se voir.** C'est la leçon de la boucle
//    invisible : « le décompte repartait, de vrais tours tournaient, et l'écran
//    ne bougeait pas d'une ligne ». Chaque message en attente coûte un tour, et
//    doit donc être à l'écran, et retirable.
//
// 2. **Une file qui repart après « Stop ».** Arrêter puis voir partir le
//    message suivant est le contraire de ce qu'on vient de demander.
//
// 3. **Une file qui enchaîne sur une erreur.** Trois échecs identiques
//    défileraient pendant qu'on lit le premier.
//
// 4. **Une file qui ne tourne que dans l'onglet regardé.** Tout l'intérêt des
//    onglets est qu'un tour continue pendant qu'on lit ailleurs ; une file qui
//    s'arrête quand on change de fenêtre s'arrête au moment où l'on comptait
//    dessus.
//
// 5. **Une file qui survit à la fermeture.** Ces messages n'ont jamais été
//    envoyés : les retrouver au démarrage suivant les ferait partir tout seuls,
//    longtemps après, chacun pour un tour payé.
//
//     node scripts/check-queue.mjs
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")

// ---- la file appartient à la conversation --------------------------------
{
  // Comme `busy`, et pour la même raison : un tour lancé dans un onglet
  // continue pendant qu'on lit un autre. Une file par panneau enverrait la
  // suite d'une conversation dans une autre.
  check(
    "**la file est portée par la conversation**",
    /queued: Queued\[\]/.test(panel),
    "une file de panneau enverrait la suite d'un fil dans un autre"
  )
  check("et un fil neuf en a une vide", /blankThread[\s\S]{0,600}?queued: \[\]/.test(panel))
  // Elle ne se relit pas au démarrage : ces messages n'ont jamais été envoyés.
  const restaure = panel.slice(panel.indexOf("export async function restore("))
  check(
    "**et elle ne survit pas à la fermeture**",
    /queued: \[\]/.test(restaure.slice(0, 2500)),
    "des messages jamais envoyés repartiraient tout seuls au démarrage suivant"
  )
}

// ---- écrire pendant un tour met en file ----------------------------------
{
  const envoi = panel.slice(panel.indexOf("const send = async (prompt: string)"))
  const corps = envoi.slice(0, envoi.indexOf("const stop = "))

  // Le refus d'avant : `|| thread.busy ||` dans la garde d'entrée. S'il
  // revient, la touche Entrée ne fait plus rien pendant un tour.
  check(
    "**un tour en cours ne fait plus refuser la saisie**",
    !/if \(\([\s\S]{0,120}?\|\| thread\.busy \|\|/.test(corps),
    "Entrée ne fait rien pendant un tour, et le texte reste dans la boîte"
  )
  check(
    "**ce qu'on écrit pendant un tour est mis en file**",
    /if \(thread\.busy\) \{[\s\S]{0,300}?queued: \[\.\.\.t\.queued,/.test(corps),
    "le message est perdu ou refusé"
  )
  // La boîte se vide dans les deux cas : sinon on ne sait pas si c'est parti.
  check("et la boîte se vide dans les deux cas", corps.indexOf('setDraft("")') < corps.indexOf("if (thread.busy)"))
  // Les images suivent le message qu'elles accompagnaient, pas le suivant.
  check(
    "**les images partent avec le message qu'elles accompagnaient**",
    /queued: \[\.\.\.t\.queued, \{ id: nextMessageId\(\), text, images \}\]/.test(corps),
    "une image se retrouverait collée au message d'après"
  )
}

// ---- « Stop » veut dire stop ---------------------------------------------
{
  const arret = panel.slice(panel.indexOf("const stop = (): void =>"))
  const corps = arret.slice(0, 1400)
  check(
    "**arrêter vide la file**",
    /mapThread\(thread\.id, \(t\) => \(\{ \.\.\.t, queued: \[\]/.test(corps),
    "le message suivant partirait juste après qu'on a cliqué sur Stop"
  )
  // Mais sans perdre ce qui était écrit : la boîte est vide à ce moment-là.
  check(
    "**sans perdre ce qui était écrit**",
    corps.includes("setDraft((actuel) =>"),
    "on jette ce que quelqu'un venait de taper"
  )
}

// ---- la suite ne part que quand elle le doit -----------------------------
{
  const suite = panel.slice(panel.indexOf("function advance("))
  const corps = suite.slice(0, suite.indexOf("function endTurn("))
  check("**une file avance à la fin d'un tour**", corps.includes("mapThread(threadId, (t) => ({ ...t, queued: reste }))"))
  check(
    "**et pas après un arrêt ni une erreur**",
    /if \(!ok\) return/.test(corps),
    "Stop ou une erreur enchaînerait quand même"
  )
  // Ce que `endTurn` lui passe : arrêté OU en erreur, la file ne bouge pas.
  const fin = panel.slice(panel.indexOf("function endTurn("))
  check(
    "et c'est la fin de tour qui le décide",
    /advance\(bound\.threadId, !arrete && !fini\?\.error\)/.test(fin),
    "la file avancerait sur un tour arrêté ou raté"
  )
}

// ---- même dans un onglet qu'on ne regarde pas ----------------------------
{
  // `dispatch` est au niveau du module, pas dans le composant : c'est ce qui
  // permet à la file d'un onglet caché d'avancer.
  check(
    "**l'envoi ne dépend pas de l'écran**",
    /^async function dispatch\(threadId: string/m.test(panel),
    "une file ne tournerait que dans la conversation affichée"
  )
  check(
    "et il lit le projet et la permission au moment d'envoyer",
    /useWorkspace\.getState\(\)\.project\?\.project/.test(panel) && /permissionFor\(projectDir\)/.test(panel)
  )
}

// ---- et ça se voit ------------------------------------------------------
{
  check(
    "**les messages en attente sont à l'écran**",
    panel.includes("thread.queued.length > 0") && panel.includes("Remove from the queue"),
    "une file invisible qui dépense, exactement ce qu'on a corrigé pour les boucles"
  )
  check("et chacun se retire", /queued: t\.queued\.filter\(\(x\) => x\.id !== q\.id\)/.test(panel))
}

console.log(
  failures === 0
    ? "\nCe qu'on écrit pendant un tour part au suivant, se voit, et s'arrête quand on arrête."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
