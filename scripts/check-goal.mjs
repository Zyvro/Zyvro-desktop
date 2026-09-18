// Le but d'une session.
//
// C'est la différence entre un chat et un atelier : un but tapé au troisième
// message a disparu de l'écran au dixième, alors que les deux harnais le savent
// et le disent.
//
// Ils ne le disent pas pareil, et les deux formes sont relevées sur les
// binaires — ce sont les charges utiles exactes qu'ils ont émises ici :
//
//   qwen    un `stream_event` dont l'`event.goal_state` porte tout. Réémis à
//           CHAQUE événement du flux — une douzaine par tour — d'où la
//           nécessité de ne prévenir la fenêtre que quand il change.
//   claude  rien de structuré : `/goal` répond en texte. Mais le résultat porte
//           `local_command: "goal"`, et c'est ce marqueur qui permet de lire ce
//           texte sans deviner — sans lui, une réponse du modèle contenant
//           « goal active » deviendrait un but.
//
// Ce qui casse en silence ici : confondre « cet événement ne parle pas de but »
// avec « il n'y a pas de but ». La première efface le but à chaque message.
//
//     node scripts/check-goal.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-goal-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { goalIn, sameGoal } from "${path.join(ROOT, "src/main/goal").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { goalIn, sameGoal } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

// ---- qwen : l'état structuré, tel qu'il l'émet ---------------------------
{
  const evenement = {
    type: "stream_event",
    uuid: "e94f7b98",
    session_id: "b09c3f39",
    parent_tool_use_id: null,
    event: {
      type: "goal_state",
      goal_state: {
        v: 2,
        goal: {
          goalId: "f9325fb3",
          revision: 1,
          objective: "les tests passent",
          status: "active",
          turnCount: 3,
          activeTimeMs: 0,
          tokensUsed: 12000,
          tokenBudget: 30000000,
        },
        activity: "idle",
      },
    },
  }
  const lu = goalIn(evenement)
  check("**l'objectif se lit**", lu?.goal?.objective === "les tests passent", JSON.stringify(lu))
  check("le statut aussi", lu?.goal?.status === "active")
  check("les tours comptés", lu?.goal?.turns === 3)
  check("et les jetons sur leur budget", lu?.goal?.tokens?.used === 12000 && lu?.goal?.tokens?.budget === 30000000)

  // Le même événement avec `goal: null` : c'est bien une nouvelle — il n'y en a
  // plus — et pas un événement muet.
  const vide = { ...evenement, event: { type: "goal_state", goal_state: { v: 2, goal: null, activity: "idle" } } }
  check("**« plus de but » est une nouvelle, pas un silence**", JSON.stringify(goalIn(vide)) === '{"goal":null}')

  // Un budget à zéro n'est pas un budget : « 0 / 0 » serait pire que rien.
  const sansBudget = JSON.parse(JSON.stringify(evenement))
  sansBudget.event.goal_state.goal.tokenBudget = 0
  check("un budget à zéro ne s'affiche pas", goalIn(sansBudget)?.goal?.tokens === undefined)
}

// ---- claude : le texte, mais seulement quand il est marqué ----------------
{
  const actif = {
    type: "result", subtype: "success", local_command: "goal",
    result: "Goal active: les tests passent (not yet evaluated)",
  }
  const lu = goalIn(actif)
  check("**« Goal active: X (état) » se découpe**", lu?.goal?.objective === "les tests passent", JSON.stringify(lu))
  check("et la parenthèse est l'état, pas l'objectif", lu?.goal?.status === "not yet evaluated")

  const aucun = { type: "result", local_command: "goal", result: "No goal set. Usage: `/goal <condition>`" }
  check("**« No goal set » efface**", JSON.stringify(goalIn(aucun)) === '{"goal":null}')

  // La tournure appartient à la CLI et peut changer. Perdre le but parce qu'elle
  // a bougé serait pire qu'épingler une phrase un peu longue : tout ce qui n'est
  // pas « aucun but » est un but.
  const autreTournure = { type: "result", local_command: "goal", result: "Goal set: le panneau affiche le but" }
  check(
    "**une tournure qu'on ne connaît pas s'épingle quand même**",
    goalIn(autreTournure)?.goal?.objective === "Goal set: le panneau affiche le but",
    JSON.stringify(goalIn(autreTournure))
  )

  // Sans le marqueur, rien : une réponse du modèle qui parle de buts n'en est
  // pas un.
  const modele = { type: "result", subtype: "success", result: "Goal active: je vais commencer par lire les tests" }
  check("**sans le marqueur, le modèle ne fixe pas de but**", goalIn(modele) === null, JSON.stringify(goalIn(modele)))
  const autreCommande = { type: "result", local_command: "context", result: "## Context Usage" }
  check("ni une autre commande", goalIn(autreCommande) === null)
}

// ---- ce qui ne parle pas de but ------------------------------------------
{
  check("un message ordinaire ne dit rien du but", goalIn({ type: "assistant", message: {} }) === null)
  check("un init non plus", goalIn({ type: "system", subtype: "init" }) === null)
  check("ni un stream_event d'autre chose", goalIn({ type: "stream_event", event: { type: "text_delta" } }) === null)
}

// ---- ne pas réveiller la fenêtre pour rien -------------------------------
{
  const a = { objective: "x", status: "active", turns: 1, tokens: { used: 5, budget: 10 } }
  check("**le même état ne traverse pas**", sameGoal(a, { ...a }))
  check("un objectif différent, si", !sameGoal(a, { ...a, objective: "y" }))
  check("un tour de plus aussi", !sameGoal(a, { ...a, turns: 2 }))
  check("des jetons de plus aussi", !sameGoal(a, { ...a, tokens: { used: 6, budget: 10 } }))
  check("et apparaître ou disparaître compte", !sameGoal(null, a) && !sameGoal(a, null) && sameGoal(null, null))
}

// ---- et il est épinglé, pas noyé -----------------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const avantDefilement = panel.slice(0, panel.indexOf('ref={scrollRef}'))
  check(
    "**le but est au-dessus du défilement**",
    avantDefilement.includes("<GoalBanner goal={thread.goal} />"),
    "le but est dans le défilement : il disparaît au dixième message"
  )
  check(
    "et il survit à la fermeture de l'application",
    panel.includes("goal: c.goal ?? null") && panel.includes("goal: thread.goal"),
    "le but n'est pas écrit avec la conversation"
  )
  // Inventer une barre de progression là où le harnais ne donne aucun chiffre
  // serait dessiner une certitude que personne n'a.
  check(
    "**et rien n'est inventé quand le harnais ne compte pas**",
    panel.includes("goal.turns !== undefined") && panel.includes("goal.tokens ?"),
    "l'avancement est affiché même sans chiffre"
  )
}

console.log(
  failures === 0
    ? "\nLe but de la session se lit chez les deux harnais, et reste à l'écran."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
