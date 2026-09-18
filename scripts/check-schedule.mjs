// Une session qui continue quand le processus est mort.
//
// Le panneau lance un processus par tour ; quand il sort, le tour est fini.
// C'est exactement ce qui empêchait `/loop` de vouloir dire quelque chose ici,
// et ce n'est pas « ça ne marche pas », c'est pire — relevé sur le binaire :
//
//   · `/loop 60 <tâche>` appelle `CronCreate {cron:"* * * * *", …}` et répond
//     « planifié toutes les minutes, job bc5a079a ». Une session plus tard,
//     `CronList` ne rend rien : les tâches sont en mémoire, dans la session. La
//     phrase promettait une récurrence morte avec le processus.
//   · `/loop <tâche>` appelle `ScheduleWakeup {delaySeconds:1200, …}` dont le
//     résultat dit « the harness re-invokes you when the wakeup fires ». Le
//     harnais, ici, c'est nous.
//
// Rien n'est donc détourné et rien ne fait double emploi : ce que la CLI avait
// planifié n'existe plus dès qu'elle sort.
//
// Ce qui casse en silence ici :
//
// 1. **Deux minuteries pour une conversation.** La boucle se dédouble à chaque
//    passage, et à la troisième l'agent répond quatre fois.
// 2. **Un cron pris pour un rythme.** `30 * * * *` veut dire « à la trentième
//    minute », pas « toutes les heures » : le premier passage partirait au
//    mauvais moment et personne ne le verrait avant une demi-heure de trop.
// 3. **Un réarmement après le tour.** Si le tour dure trois minutes, « toutes
//    les minutes » devient « toutes les quatre minutes ».
//
//     node scripts/check-schedule.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-schedule-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { wakeIn, nextRunIn } from "${path.join(ROOT, "src/main/schedule").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { wakeIn, nextRunIn } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const assistant = (...outils) => ({
  type: "assistant",
  message: { role: "assistant", content: outils.map((o) => ({ type: "tool_use", ...o })) },
})

// ---- ce que la CLI a vraiment émis ---------------------------------------
{
  // Relevé sur `/loop compte les fichiers de ce dossier et dis juste le nombre`.
  const reveil = assistant({
    name: "ScheduleWakeup",
    input: {
      delaySeconds: 1200,
      noop: false,
      prompt: "/loop compte les fichiers de ce dossier et dis juste le nombre",
      reason: "Pas de Monitor autorisé : recomptage périodique du dossier toutes les 20 min.",
    },
  })
  const lu = wakeIn(reveil)
  check("**un réveil se lit**", lu?.delaySeconds === 1200, JSON.stringify(lu))
  check("avec ce qu'on redemandera, mot pour mot", lu?.prompt.startsWith("/loop compte les fichiers"))
  // Un réveil unique : le tour suivant en redemandera un, ou pas, et c'est lui
  // qui décide. Le réarmer nous-mêmes, ce serait décider à sa place.
  check("**et il ne se réarme pas tout seul**", lu?.recurring === false)

  // Relevé sur `/loop 60 …`.
  const cron = assistant({
    name: "CronCreate",
    input: { cron: "* * * * *", prompt: "compte les fichiers de ce dossier et dis juste le nombre", recurring: true },
  })
  const luCron = wakeIn(cron)
  // Pas « dans 60 s » mais « à la prochaine minute » : le premier passage tombe
  // sur la minute suivante, donc entre 1 et 60 secondes d'ici.
  check(
    "**un cron vise la prochaine occurrence, pas un intervalle**",
    luCron !== null && luCron.delaySeconds > 0 && luCron.delaySeconds <= 60,
    JSON.stringify(luCron)
  )
  check("et celui-là se réarme", luCron?.recurring === true)
  // L'expression voyage avec le rendez-vous : le passage suivant se recalcule
  // depuis elle, sinon tous dérivent de la durée du premier tour.
  check("**et l'expression voyage avec lui**", luCron?.cron === "* * * * *")

  // `stop` arrête, et c'est le seul champ qui compte alors.
  check("**stop arrête**", JSON.stringify(wakeIn(assistant({ name: "ScheduleWakeup", input: { stop: true } }))) === '{"stop":true}')
  // Un tour qui planifie puis annule a annulé : le dernier gagne.
  const lesDeux = assistant(
    { name: "ScheduleWakeup", input: { delaySeconds: 60, prompt: "x" } },
    { name: "ScheduleWakeup", input: { stop: true } }
  )
  check("**planifier puis annuler, c'est annuler**", wakeIn(lesDeux)?.stop === true)
}

// ---- ce qui n'est pas une demande de réveil ------------------------------
{
  check("un message ordinaire n'en demande pas", wakeIn({ type: "assistant", message: { content: [{ type: "text", text: "/loop" }] } }) === null)
  check("un autre outil non plus", wakeIn(assistant({ name: "Bash", input: { command: "ls" } })) === null)
  check("un résultat non plus", wakeIn({ type: "result", result: "fini" }) === null)
  // Sans délai ou sans question, il n'y a rien à tenir.
  check("**un réveil sans délai ne s'arme pas**", wakeIn(assistant({ name: "ScheduleWakeup", input: { prompt: "x" } })) === null)
  check("ni un réveil sans question", wakeIn(assistant({ name: "ScheduleWakeup", input: { delaySeconds: 60 } })) === null)
  check("ni un délai négatif", wakeIn(assistant({ name: "ScheduleWakeup", input: { delaySeconds: -5, prompt: "x" } })) === null)
}

// ---- un cron se calcule, il ne s'approxime pas ---------------------------
//
// La première version convertissait l'expression en intervalle. C'est faux
// d'une façon qui ne se voit pas : un cron dit « à telle minute de telle
// heure », et repartir « dans une heure » à partir de maintenant fait tomber
// tous les passages à côté. Sur `0 9 * * *`, c'est une tâche quotidienne qui
// s'exécute à trois heures du matin. Elle était en plus incohérente avec
// elle-même : elle acceptait `0 */2 * * *` et refusait `0 * * * *`, ancrés
// pareil.
{
  // Un mardi à 10 h 30 précises, pour que les attentes soient des dates et non
  // des « à peu près ».
  const mardi = new Date(2026, 8, 15, 10, 30, 0, 0).getTime()
  const minutes = (ms) => (ms === null ? null : Math.round(ms / 60000))

  check("**toutes les minutes : la minute suivante**", minutes(nextRunIn("* * * * *", mardi)) === 1)
  check("toutes les 5 minutes : 10 h 35", minutes(nextRunIn("*/5 * * * *", mardi)) === 5)
  // Et pas « dans une heure » : à la prochaine heure pile, dans 30 minutes.
  check("**toutes les heures : l'heure pile, pas dans une heure**", minutes(nextRunIn("0 * * * *", mardi)) === 30)
  check("à la trentième minute : dans une heure, pas tout de suite", minutes(nextRunIn("30 * * * *", mardi)) === 60)
  // Une tâche quotidienne de 9 h tombe le lendemain à 9 h, soit 22 h 30.
  check("**tous les jours à 9 h : demain 9 h**", minutes(nextRunIn("0 9 * * *", mardi)) === 22 * 60 + 30)
  check("toutes les 2 heures : midi", minutes(nextRunIn("0 */2 * * *", mardi)) === 90)

  // Jamais la minute en cours : repartir dessus ferait un passage immédiat à
  // chaque tour, donc une boucle qui tourne à vide.
  const pile = new Date(2026, 8, 15, 10, 0, 0, 0).getTime()
  check("**jamais la minute en cours**", minutes(nextRunIn("0 * * * *", pile)) === 60)

  // Au-delà, ce sont des dates, et une date se tient avec un calendrier.
  check("« le lundi » n'est pas tenu ici", nextRunIn("* * * * 1", mardi) === null)
  check("ni « le 1er du mois »", nextRunIn("0 0 1 * *", mardi) === null)
  check("une expression malformée non plus", nextRunIn("* * *", mardi) === null && nextRunIn("", mardi) === null)
  check("ni un pas absurde", nextRunIn("*/0 * * * *", mardi) === null && nextRunIn("*/90 * * * *", mardi) === null)
  check("ni une valeur hors bornes", nextRunIn("0 25 * * *", mardi) === null && nextRunIn("60 * * * *", mardi) === null)
  // Les listes et les intervalles ne sont pas lus : en lire une à moitié serait
  // pire que de refuser.
  check("ni une liste ou un intervalle, pas lus", nextRunIn("1,15 * * * *", mardi) === null && nextRunIn("0 9-17 * * *", mardi) === null)
}

// ---- une seule minuterie, réarmée avant de partir -------------------------
{
  const agent = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  const bloc = agent.slice(agent.indexOf("private schedule("), agent.indexOf("private clearTimer("))
  check(
    "**armer écrase ce qui était armé**",
    bloc.includes("this.clearTimer(conversationId)"),
    "deux minuteries pour une conversation : la boucle se dédouble à chaque passage"
  )
  // Réarmer AVANT de lancer le tour : sinon le temps du tour s'ajoute au rythme.
  check(
    "**le rythme se réarme avant de partir**",
    bloc.indexOf("if (every !== null) this.schedule(") < bloc.indexOf("this.send(encore.target"),
    "« toutes les minutes » devient « toutes les minutes plus la durée du tour »"
  )
  // Une minuterie ne doit pas retenir le processus au moment de quitter.
  check("et elle ne retient pas l'application", bloc.includes("timer.unref?.()"))
  // Le prochain passage se recalcule à chaque fois : figer le délai du premier
  // ferait dériver tous les suivants de la durée du tour.
  check(
    "**et le prochain passage se recalcule, il ne se recopie pas**",
    bloc.includes("nextRunIn(cron, Date.now())"),
    "le délai du premier passage est réutilisé tel quel"
  )
  check(
    "**ce qu'il faut pour refaire le tour est retenu à l'envoi**",
    agent.includes("this.repeats.set(conversationId, { target, kind, ctx, model, aim })"),
    "un réveil repartirait sur un modèle deviné"
  )
  check(
    "et une fenêtre fermée n'est pas réveillée",
    bloc.includes("repeat.target.isDestroyed()"),
    "on parle à une fenêtre qui n'existe plus"
  )
}

// ---- et on peut l'arrêter depuis là où on le voit -------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const avantDefilement = panel.slice(0, panel.indexOf("ref={scrollRef}"))
  check("**le rendez-vous est au-dessus du défilement**", avantDefilement.includes("<ScheduleBanner"))
  // Une boucle qu'on ne peut pas arrêter depuis l'endroit où on la voit n'est
  // pas une fonctionnalité, c'est une fuite.
  check("**et il porte son bouton d'arrêt**", panel.includes("window.zyvro.agent.unschedule(thread.id)"))
  // Un décompte qui décrémente dérive de tout le temps passé en arrière-plan.
  // Un tour né d'une minuterie n'a pas de message : ses événements arrivent
  // sans destination et sont garés indéfiniment. Vu en éprouvant la boucle — le
  // décompte repartait, de vrais tours tournaient, et l'écran ne bougeait pas
  // d'une ligne. Une boucle invisible qui dépense est pire qu'une boucle qui ne
  // tourne pas.
  check(
    "**un tour parti tout seul reçoit ses bulles**",
    panel.includes("onWoke(") && panel.includes("bindTurn(conversationId, beginTurn(conversationId, prompt), turnId)"),
    "la boucle tourne et dépense sans que rien ne s'affiche"
  )
  const agentSrc = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  check(
    "et le principal le lui dit",
    agentSrc.includes('encore.target.send("agent:woke"'),
    "personne ne prévient la fenêtre qu'un tour est parti"
  )

  check(
    "le décompte se recalcule depuis une date absolue",
    panel.includes("pending.at - maintenant * 1000"),
    "le compteur dérive quand la fenêtre est en arrière-plan"
  )
}

console.log(
  failures === 0
    ? "\nUne session garde son rendez-vous quand le processus sort, et on peut l'arrêter."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
