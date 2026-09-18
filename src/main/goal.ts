// Le but d'une session : ce vers quoi l'agent travaille.
//
// C'est la différence entre un chat et un atelier. Un but tapé au troisième
// message file dans le défilement au dixième, et plus rien à l'écran ne dit
// vers quoi on va — alors que les deux harnais le savent et le disent.
//
// Ils ne le disent pas de la même façon, et les deux formes ont été relevées
// sur les binaires plutôt que devinées :
//
//   qwen    un `stream_event` dont l'`event.goal_state` porte tout — objectif,
//           statut, tours écoulés, jetons consommés sur un budget. Réémis à
//           chaque événement du flux, d'où le besoin de ne prévenir la fenêtre
//           que quand il change.
//
//   claude  rien de structuré. Son `/goal` répond en texte — « Goal set: les
//           tests passent », « Goal active: … (not yet evaluated) », ou « No
//           goal set. Usage:… ». Mais l'événement porte
//           `local_command_run: {command: "goal", args: …}`, et c'est ce
//           marqueur qui permet de le lire sans deviner : on sait alors que ce
//           texte EST le rapport du but, et pas une phrase du modèle qui en
//           parlerait.
//
// Ce que ce commentaire affirmait et qui est faux (corrigé le 18/09 en le
// faisant tourner) : « chez claude le but survit à une reprise de session ».
// Non, pas en mode impression. Un but posé dans un tour, puis `--resume` et
// `/goal` : « No goal set ». Chaque tour est un processus, et la commande
// locale ne laisse rien derrière elle. Le bandeau montre donc ce que le dernier
// tour a dit du but — ce qui reste ce que la personne vient de demander, et
// s'efface quand le harnais répond qu'il n'y en a pas.

export type Goal = {
  /** Ce qu'on cherche à obtenir, dans les mots de la personne. */
  objective: string
  /** Ce que le harnais en dit : « active », « achieved »… ou rien. */
  status: string
  /** Tours passés dessus, quand le harnais les compte. */
  turns?: number
  /** Jetons dépensés sur le budget alloué, quand il y en a un. */
  tokens?: { used: number; budget: number }
}

/**
 * Ce qu'un événement dit du but.
 *
 * Trois réponses possibles, et la distinction compte :
 *   null            cet événement ne parle pas de but — on ne touche à rien
 *   { goal: null }  il en parle, et il n'y en a pas — on efface
 *   { goal: … }     il y en a un
 *
 * Confondre les deux premières effacerait le but à chaque message.
 */
export function goalIn(event: Record<string, unknown>): { goal: Goal | null } | null {
  const structure = qwenGoal(event)
  if (structure) return structure
  return claudeGoal(event)
}

function nombre(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function qwenGoal(event: Record<string, unknown>): { goal: Goal | null } | null {
  if (event.type !== "stream_event") return null
  const inner = (event.event && typeof event.event === "object" ? event.event : {}) as Record<string, unknown>
  if (inner.type !== "goal_state") return null
  const state = (inner.goal_state && typeof inner.goal_state === "object" ? inner.goal_state : {}) as Record<
    string,
    unknown
  >
  const goal = (state.goal && typeof state.goal === "object" ? state.goal : null) as Record<string, unknown> | null
  if (!goal) return { goal: null }
  const objective = typeof goal.objective === "string" ? goal.objective.trim() : ""
  if (!objective) return { goal: null }

  const used = nombre(goal.tokensUsed)
  const budget = nombre(goal.tokenBudget)
  return {
    goal: {
      objective,
      status: typeof goal.status === "string" ? goal.status : "",
      turns: nombre(goal.turnCount),
      // Un budget à zéro n'est pas un budget : afficher « 0 / 0 » serait pire
      // que de ne rien afficher.
      tokens: used !== undefined && budget ? { used, budget } : undefined,
    },
  }
}

// Le texte de claude, lu seulement quand il est marqué comme venant de `/goal`.
//
// Le marqueur est ce qui rend la lecture honnête : sans lui il faudrait
// reconnaître un but au milieu de tout ce que le modèle écrit, et une réponse
// qui contient « goal active » deviendrait un but.
//
// La forme, elle, appartient à la CLI et peut changer. La règle est donc
// volontairement lâche : « aucun but » se reconnaît, et TOUT le reste est un
// but — quitte à épingler la phrase telle quelle. Perdre le but parce que la
// tournure a bougé serait pire que d'épingler une phrase un peu longue.
// claudeGoal : le marqueur n'est pas là où ce fichier le cherchait.
//
// Il lisait `local_command === "goal"` sur l'événement `result`. Ni l'un ni
// l'autre n'existe : claude 2.1.276 émet un événement **assistant** portant
//
//   "local_command_run": {"command": "goal", "args": "tous les tests passent"},
//   "local_command_source": "<local-command-stdout>Goal set: …</local-command-stdout>",
//   "message": {"content": [{"type": "text", "text": "Goal set: …"}]}
//
// Relevé en le faisant tourner, ce qui aurait dû être fait la première fois : le
// carnet disait « la lecture est juste et gardée contre les vraies charges
// utiles ; il reste à la voir allumée ». Elle n'était pas juste, et c'est
// précisément parce qu'on ne l'avait jamais vue allumée que personne ne le
// savait. Un garde écrit sur une charge utile inventée vérifie l'invention.
//
// Ce qui ne change pas : c'est le marqueur du harnais qu'on lit, jamais une
// phrase du modèle. Une réponse contenant « Goal active » écrite par le modèle
// n'est pas un but, et rien ici ne la prendra pour tel.
function claudeGoal(event: Record<string, unknown>): { goal: Goal | null } | null {
  if (event.type !== "assistant") return null
  const run = (event.local_command_run && typeof event.local_command_run === "object"
    ? event.local_command_run
    : {}) as Record<string, unknown>
  if (run.command !== "goal") return null

  const texte = commandText(event)
  if (!texte || /^no goal\b/i.test(texte)) return { goal: null }

  // « Goal set: … » est la réponse à `/goal <condition>`, « Goal active: … »
  // celle à `/goal` tout seul. Les deux disent le même but.
  const pose = /^goal\s+(?:set|active)\s*:\s*(.+)$/is.exec(texte)
  if (!pose) return { goal: { objective: texte, status: "" } }

  let reste = pose[1].trim()
  let status = "active"
  // « … (not yet evaluated) » : la parenthèse finale est ce que le harnais dit
  // de l'état, pas une partie de l'objectif.
  const parenthese = /^(.*?)\s*\(([^()]*)\)$/s.exec(reste)
  if (parenthese) {
    reste = parenthese[1].trim()
    status = parenthese[2].trim() || status
  }
  return { goal: { objective: reste, status } }
}

// commandText : ce que la commande a imprimé.
//
// Deux endroits le portent, et on prend celui qui est déjà propre. Le second
// arrive enveloppé — `<local-command-stdout>…</local-command-stdout>` — parce
// que c'est la sortie brute d'une commande locale ; garder l'enveloppe ferait
// un but épinglé qui commence par une balise.
function commandText(event: Record<string, unknown>): string {
  const message = (event.message && typeof event.message === "object" ? event.message : {}) as Record<string, unknown>
  const blocs = Array.isArray(message.content) ? message.content : []
  const texte = blocs
    .map((b) => {
      const bloc = (b && typeof b === "object" ? b : {}) as Record<string, unknown>
      return bloc.type === "text" && typeof bloc.text === "string" ? bloc.text : ""
    })
    .join("")
    .trim()
  if (texte) return texte

  const brut = typeof event.local_command_source === "string" ? event.local_command_source : ""
  return brut.replace(/<\/?local-command-[a-z]+>/gi, "").trim()
}

// sameGoal : deux états du but qui ne diffèrent en rien.
//
// qwen réémet le sien à chaque événement du flux — une douzaine par tour — et
// prévenir la fenêtre douze fois pour la même phrase, c'est douze rendus et une
// sauvegarde du transcript pour rien.
export function sameGoal(a: Goal | null, b: Goal | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.objective === b.objective &&
    a.status === b.status &&
    a.turns === b.turns &&
    a.tokens?.used === b.tokens?.used &&
    a.tokens?.budget === b.tokens?.budget
  )
}
