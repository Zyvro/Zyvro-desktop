// Une question que l'agent pose à la personne, et sa réponse.
//
// Claude et Codex posent la même chose — une à quatre questions, des options,
// parfois un choix multiple, parfois un champ libre — dans deux formes qui ne
// se ressemblent pas. Le panneau n'en dessine qu'une : celle-ci. Les deux
// traductions vivent ici, à côté l'une de l'autre, et le relevé des formes
// natives est dans features/agent-questions.md.
//
// Partagé par le principal et le rendu, donc n'importe rien.

export type QuestionOption = { label: string; description: string }

export type AgentQuestion = {
  /** Ce par quoi la réponse revient : le texte chez Claude, un id chez Codex. */
  id: string
  header: string
  question: string
  multiSelect: boolean
  /** Un champ « Autre », pour répondre hors des options. */
  other: boolean
  /** Une saisie masquée. */
  secret: boolean
  options: QuestionOption[]
}

/** Les réponses, par identifiant de question. Plusieurs pour un choix multiple. */
export type QuestionAnswers = Record<string, string[]>

/** Le nom de l'outil par lequel Claude pose ses questions. */
export const ASK_USER_QUESTION = "AskUserQuestion"

const str = (v: unknown): string => (typeof v === "string" ? v : "")

function optionsOf(v: unknown): QuestionOption[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
    .map((o) => ({ label: str(o.label), description: str(o.description) }))
    .filter((o) => o.label !== "")
}

// ---- Claude : AskUserQuestion, par l'outil de permission -------------------

/** Les questions d'un appel à AskUserQuestion, ou null si l'entrée n'en a pas. */
export function questionsFromClaude(input: Record<string, unknown>): AgentQuestion[] | null {
  if (!Array.isArray(input.questions)) return null
  const questions = input.questions
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === "object")
    .map((q) => ({
      id: str(q.question),
      header: str(q.header),
      question: str(q.question),
      multiSelect: q.multiSelect === true,
      // Le schéma de Claude interdit l'option « Autre » dans la liste : c'est à
      // l'interface de l'offrir, toujours.
      other: true,
      secret: false,
      options: optionsOf(q.options),
    }))
    .filter((q) => q.question !== "")
  return questions.length > 0 ? questions : null
}

/**
 * L'entrée qu'on rend à Claude avec `allow` : la sienne, plus `answers`.
 *
 * Indexé par le texte de la question, une seule chaîne par question — un choix
 * multiple y est joint par des virgules. C'est ce que dit son schéma, et ce que
 * le modèle a relu : `"Which color do you prefer?"="Blue"`.
 */
export function claudeAnswerInput(
  input: Record<string, unknown>,
  questions: AgentQuestion[],
  answers: QuestionAnswers
): Record<string, unknown> {
  const joined: Record<string, string> = {}
  for (const q of questions) {
    const picked = (answers[q.id] ?? []).map((a) => a.trim()).filter(Boolean)
    if (picked.length > 0) joined[q.question] = picked.join(", ")
  }
  return { ...input, answers: joined }
}

// ---- Codex : item/tool/requestUserInput, par le serveur d'application -------

/** Les questions d'une requête `item/tool/requestUserInput`. */
export function questionsFromCodex(params: Record<string, unknown>): AgentQuestion[] {
  if (!Array.isArray(params.questions)) return []
  return params.questions
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === "object")
    .map((q) => {
      const options = optionsOf(q.options)
      return {
        id: str(q.id) || str(q.question),
        header: str(q.header),
        question: str(q.question),
        multiSelect: false,
        // Sans option, la question est un champ libre : il faut bien un endroit
        // où écrire.
        other: q.isOther === true || options.length === 0,
        secret: q.isSecret === true,
        options,
      }
    })
    .filter((q) => q.id !== "" && q.question !== "")
}

/** Le résultat qu'on rend à Codex : par id, toujours une liste. */
export function codexAnswerResult(questions: AgentQuestion[], answers: QuestionAnswers): { answers: Record<string, { answers: string[] }> } {
  const out: Record<string, { answers: string[] }> = {}
  for (const q of questions) out[q.id] = { answers: (answers[q.id] ?? []).map((a) => a.trim()).filter(Boolean) }
  return { answers: out }
}
