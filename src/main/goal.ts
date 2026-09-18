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
//   claude  rien de structuré. Son `/goal` répond en texte — « Goal active: les
//           tests passent (not yet evaluated) », ou « No goal set. Usage:… ».
//           Mais le résultat porte `local_command: "goal"`, et c'est ce marqueur
//           qui permet de le lire sans deviner : on sait alors que ce texte EST
//           le rapport du but, et pas une phrase du modèle qui en parlerait.
//
// Vérifié aussi : chez claude le but survit à une reprise de session. Le
// montrer en tête n'est donc pas un affichage éphémère, c'est l'état réel de la
// session qu'on rouvre.

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
function claudeGoal(event: Record<string, unknown>): { goal: Goal | null } | null {
  if (event.type !== "result" || event.local_command !== "goal") return null
  const texte = typeof event.result === "string" ? event.result.trim() : ""
  if (!texte || /^no goal\b/i.test(texte)) return { goal: null }

  const actif = /^goal\s+active\s*:\s*(.+)$/i.exec(texte)
  if (!actif) return { goal: { objective: texte, status: "" } }

  let reste = actif[1].trim()
  let status = "active"
  // « … (not yet evaluated) » : la parenthèse finale est ce que le harnais dit
  // de l'état, pas une partie de l'objectif.
  const parenthese = /^(.*?)\s*\(([^()]*)\)$/.exec(reste)
  if (parenthese) {
    reste = parenthese[1].trim()
    status = parenthese[2].trim() || status
  }
  return { goal: { objective: reste, status } }
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
