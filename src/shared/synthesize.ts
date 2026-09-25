// Auto-synthèse : réécrire ce qu'on demande à l'agent avant de l'envoyer.
//
// Demandé : une option du chat qui fait gagner le prompt en capacité — le
// traduire en anglais (les modèles y sont meilleurs, et un projet mêle souvent
// les langues), l'améliorer, ou d'autres. Et pouvoir écrire puis laisser la
// synthèse partir d'elle-même.
//
// Les modes retenus, parce que ce sont eux qui changent ce que l'agent fait :
//
//   english    traduire en anglais, sans rien ajouter ;
//   improve    clarifier : le but, le contexte donné, les contraintes, ce qui
//              dit que c'est fini — sans inventer d'exigence ;
//   both       les deux : améliorer, en anglais ;
//   task       un cahier des charges structuré (Goal / Context / Requirements /
//              Done when), pour une tâche qu'on confie en entier.
//
// La règle commune, celle qui fait que l'outil reste sûr : ne rien inventer,
// ne rien retirer, garder tel quel le code, les chemins, les noms, les
// commandes et les messages d'erreur. Pur : `scripts/check-synthesize.mjs`.

export type SynthesisMode = "off" | "english" | "improve" | "both" | "task"

export const SYNTHESIS_MODES: { value: SynthesisMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Send what you type, as you type it." },
  { value: "english", label: "Translate to English", hint: "Same request, in English. Nothing added." },
  { value: "improve", label: "Improve", hint: "Clearer goal, context and constraints, in your language. Nothing invented." },
  { value: "both", label: "Improve in English", hint: "Both: a clearer request, in English." },
  { value: "task", label: "Structured task", hint: "Goal, context, requirements, and what “done” means." },
]

const COMMUN = `Rules that always apply:
- Never invent requirements, facts, files or constraints that the request does not state or clearly imply.
- Do not add features, validation, tests, steps or extra scope the request does not ask for; making the request clearer is not making it bigger.
- Never drop anything the request says.
- Keep code, file paths, identifiers, commands, URLs, numbers and error messages exactly as written.
- Address the coding agent directly, as the user would.
- Output only the rewritten request. No preamble, no explanation, no quotes around it, no code fence around the whole thing.`

const CONSIGNES: Record<Exclude<SynthesisMode, "off">, string> = {
  english: `Translate the user's request for a coding agent into clear, natural English. If it is already in English, return it unchanged except for obvious typos.`,
  improve: `Rewrite the user's request for a coding agent so it is clearer and more actionable, in the same language as the request: state the goal first, then the relevant context it gives, the constraints, and how to tell the work is done when that can be inferred. Keep it about as short as the request allows; do not pad it.`,
  both: `Rewrite the user's request for a coding agent in clear English so it is more actionable: state the goal first, then the relevant context it gives, the constraints, and how to tell the work is done when that can be inferred. Keep it about as short as the request allows; do not pad it.`,
  task: `Turn the user's request for a coding agent into a short structured task, in the same language as the request, with these headings: Goal, Context, Requirements (a bulleted list), Done when. Leave a heading out when the request says nothing that belongs under it.`,
}

export function synthesisPrompt(mode: Exclude<SynthesisMode, "off">, request: string): string {
  return `${CONSIGNES[mode]}\n\n${COMMUN}\n\n---\n\nThe user's request:\n\n${request}`
}

// Ce que les CLI ajoutent autour d'une réponse : une clôture de code, des
// guillemets, les lignes de journal de codex. Ce qui reste est la demande.
export function cleanSynthesis(raw: string): string {
  let text = raw.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence) text = fence[1].trim()
  const lines = text.split("\n")
  while (lines.length > 0 && /^\[\d{4}-\d{2}-\d{2}T|^(thinking|codex|tokens used|User instructions|--------)\b/i.test(lines[0].trim())) {
    lines.shift()
  }
  text = lines.join("\n").trim()
  const quoted = /^"([\s\S]+)"$/.exec(text)
  if (quoted) text = quoted[1].trim()
  return text
}

export function isSynthesisMode(v: unknown): v is SynthesisMode {
  return typeof v === "string" && SYNTHESIS_MODES.some((m) => m.value === v)
}
