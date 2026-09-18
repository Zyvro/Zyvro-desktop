// Ce qui fait qu'une session continue quand le processus est mort.
//
// Le panneau lance un processus par tour ; quand il sort, le tour est fini.
// C'est très bien pour une question, et c'est exactement ce qui empêche `/loop`
// de vouloir dire quelque chose ici : la boucle planifie un réveil, le
// processus sort, et il n'y a personne pour réveiller quoi que ce soit.
//
// Vérifié plutôt que supposé, et c'est pire que « ça ne marche pas » :
//
//   · `/loop 60 <tâche>` fait appeler `CronCreate {cron:"* * * * *", prompt,
//     recurring:true}` et répond « planifié toutes les minutes, job bc5a079a ».
//     Une session plus tard, `CronList` ne rend rien : **les tâches sont en
//     mémoire, dans la session**. La phrase promettait une récurrence qui est
//     morte avec le processus.
//
//   · `/loop <tâche>` fait appeler `ScheduleWakeup {delaySeconds:1200, prompt,
//     reason}` et le résultat dit : « the harness re-invokes you when the
//     wakeup fires ». Le harnais, ici, c'est nous. Personne ne réveillait.
//
// Donc rien n'est détourné et rien ne fera double emploi : ce que la CLI a
// planifié n'existe plus dès qu'elle sort. Ce module lit ce qu'elle a demandé
// et le tient à sa place.

/** Ce qu'un tour a demandé pour la suite. */
export type Wake =
  | { stop: true }
  | {
      stop?: false
      /** Dans combien de temps, en secondes. */
      delaySeconds: number
      /** Ce qu'on redemandera, mot pour mot. */
      prompt: string
      /** Vrai quand c'est un rythme : on réarme après chaque passage. Faux
       *  quand c'est un réveil unique — le tour suivant en redemandera un, ou
       *  pas, et c'est lui qui décide. */
      recurring: boolean
      /** L'expression d'origine, quand elle vient d'un cron. Gardée parce que
       *  le prochain passage se recalcule à chaque fois : le délai d'un cron
       *  n'est pas constant, et le figer ferait dériver tous les suivants. */
      cron?: string
    }

// Les deux outils par lesquels un harnais demande à être rappelé. Leurs noms
// sont ceux de la CLI, relevés dans son flux.
const WAKEUP = "ScheduleWakeup"
const CRON = "CronCreate"

function positif(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function texte(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Ce qu'un événement du flux demande comme suite, ou null s'il n'en demande
 * aucune.
 *
 * Lu sur les blocs `tool_use` d'un message assistant — là où la CLI dit ce
 * qu'elle appelle. C'est déjà ce que le panneau parcourt pour afficher les
 * lignes d'outils ; on y prend une chose de plus.
 */
export function wakeIn(event: Record<string, unknown>): Wake | null {
  if (event.type !== "assistant") return null
  const message = (event.message && typeof event.message === "object" ? event.message : {}) as Record<string, unknown>
  const blocs = Array.isArray(message.content) ? message.content : []

  // Le dernier gagne : un tour qui planifie puis annule a annulé.
  let trouve: Wake | null = null
  for (const bloc of blocs) {
    const b = (bloc && typeof bloc === "object" ? bloc : {}) as Record<string, unknown>
    if (b.type !== "tool_use") continue
    const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>

    if (b.name === WAKEUP) {
      // `stop: true` arrête la boucle, et c'est le seul champ qui compte alors.
      if (input.stop === true) {
        trouve = { stop: true }
        continue
      }
      const delai = positif(input.delaySeconds)
      const prompt = texte(input.prompt)
      if (delai !== null && prompt) trouve = { delaySeconds: delai, prompt, recurring: false }
      continue
    }

    if (b.name === CRON) {
      const cron = texte(input.cron)
      const dans = nextRunIn(cron, Date.now())
      const prompt = texte(input.prompt)
      // Une expression qu'on ne sait pas tenir n'est pas tenue : mieux vaut
      // qu'elle ne parte pas que de la faire partir au mauvais moment.
      if (dans !== null && prompt) {
        trouve = {
          delaySeconds: Math.max(1, Math.round(dans / 1000)),
          prompt,
          recurring: input.recurring !== false,
          cron,
        }
      }
      continue
    }
  }
  return trouve
}

// Dans combien de millisecondes tombe la prochaine occurrence d'un cron.
//
// Calculée, pas approchée. La première version convertissait l'expression en
// intervalle — « toutes les heures » pour `0 * * * *` — et ce raccourci est
// faux d'une façon qui ne se voit pas : un cron dit « à telle minute de telle
// heure », et repartir « dans une heure » à partir de maintenant fait tomber
// tous les passages à côté. Sur `0 9 * * *`, c'est une tâche quotidienne qui
// s'exécute à trois heures du matin.
//
// Elle avait en plus le défaut d'être incohérente avec elle-même : elle
// acceptait `0 */2 * * *` et refusait `0 * * * *`, qui sont ancrés pareil.
//
// On marche donc minute par minute jusqu'à la première qui correspond, sur
// quarante-huit heures au plus — ce qui couvre tout ce qui se répète à
// l'échelle de l'heure ou du jour. Au-delà, on rend null : ce sont des dates,
// et une date se tient avec un calendrier, pas avec une minuterie de fenêtre.
export function nextRunIn(cron: string, from: number): number | null {
  const champs = cron.trim().split(/\s+/)
  if (champs.length !== 5) return null
  const [minute, heure, jour, mois, semaine] = champs
  // Le jour, le mois et le jour de la semaine doivent être « tous » : au-delà,
  // c'est un calendrier.
  if (jour !== "*" || mois !== "*" || semaine !== "*") return null
  const testeMinute = champ(minute, 60)
  const testeHeure = champ(heure, 24)
  if (!testeMinute || !testeHeure) return null

  // On part de la minute suivante : un cron ne se déclenche pas sur la minute
  // en cours, et repartir dessus ferait un passage immédiat à chaque tour.
  const depart = new Date(from)
  depart.setSeconds(0, 0)
  depart.setMinutes(depart.getMinutes() + 1)

  const MINUTES_MAX = 48 * 60
  for (let i = 0; i < MINUTES_MAX; i++) {
    const quand = new Date(depart.getTime() + i * 60_000)
    if (testeMinute(quand.getMinutes()) && testeHeure(quand.getHours())) {
      return quand.getTime() - from
    }
  }
  return null
}

// champ rend de quoi tester une valeur, ou null quand on ne sait pas lire.
//
// Trois écritures, celles qu'on rencontre : « tous », « un pas », « une
// valeur ». Les listes et les intervalles — `1,15` ou `9-17` — ne sont pas
// lus : personne ne les a vus sortir d'un `/loop`, et en lire une à moitié
// serait pire que de refuser.
function champ(expression: string, limite: number): ((valeur: number) => boolean) | null {
  if (expression === "*") return () => true

  const pas = /^\*\/(\d+)$/.exec(expression)
  if (pas) {
    const n = Number(pas[1])
    if (!(n > 0 && n < limite)) return null
    return (valeur) => valeur % n === 0
  }

  if (/^\d+$/.test(expression)) {
    const n = Number(expression)
    if (!(n >= 0 && n < limite)) return null
    return (valeur) => valeur === n
  }

  return null
}

/** Ce que la fenêtre montre d'un réveil en attente. */
export type Pending = {
  conversationId: string
  /** Quand, en millisecondes depuis l'époque — pour un décompte qui ne dérive
   *  pas quand la fenêtre est restée en arrière-plan. */
  at: number
  prompt: string
  /** L'expression qui se répète, quand il y en a une : « toutes les minutes »
   *  plutôt que « dans 40 s », qui ne dit pas la même chose. */
  cron: string | null
}
