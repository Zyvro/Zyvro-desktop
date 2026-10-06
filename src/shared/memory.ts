// La mémoire d'un projet : un fichier, `ZYVRO.md` à la racine, que chaque
// nouvelle session d'agent reçoit au démarrage.
//
// Derrière, rien de plus qu'un Markdown qu'on peut lire, corriger et versionner.
// Ce que Zyvro y ajoute, c'est l'entretien : dire quand il manque ou a vieilli,
// lancer un agent qui explore le dépôt pour l'écrire, et l'injecter sans qu'on
// ait à y penser — quel que soit le harnais, y compris ceux qui ne lisent ni
// CLAUDE.md ni AGENTS.md.

export const MEMORY_FILE = "ZYVRO.md"

/** Ce qui part dans le préambule, au plus. Au-delà, l'agent lit le fichier lui-même. */
export const MEMORY_INJECT_LIMIT = 16_000

export type MemoryState = "empty" | "fresh" | "stale"

export type MemoryInfo = {
  state: MemoryState
  /** Chemin absolu du fichier, qu'il existe ou non. */
  path: string
  text: string
  /** Dernière écriture (ms epoch), ou null s'il n'existe pas. */
  updatedAt: number | null
  /** Commits du dépôt depuis cette écriture ; null hors dépôt git. */
  commitsSince: number | null
}

const DAY = 86_400_000

/**
 * Vide, à jour ou vieillie.
 *
 * Vieillie se mesure à ce qui a bougé depuis : vingt commits, ou deux semaines
 * avec au moins un commit. Un dépôt qui ne bouge pas ne fait pas vieillir sa
 * mémoire. Hors git, il ne reste que l'âge : un mois.
 */
export function memoryState(m: { text: string | null; updatedAt: number | null; commitsSince: number | null; now: number }): MemoryState {
  if (m.text === null || m.text.trim() === "" || m.updatedAt === null) return "empty"
  const age = m.now - m.updatedAt
  if (m.commitsSince !== null) {
    return m.commitsSince >= 20 || (m.commitsSince >= 1 && age >= 14 * DAY) ? "stale" : "fresh"
  }
  return age >= 30 * DAY ? "stale" : "fresh"
}

/** Le passage du préambule qui porte la mémoire, ou "" sans mémoire. */
export function memoryPreamble(text: string | null): string {
  const body = text?.trim() ?? ""
  if (!body) return ""
  const cut = body.length > MEMORY_INJECT_LIMIT
  return [
    "",
    `Project memory (${MEMORY_FILE} at the project root, maintained with Zyvro Studio). Read it before exploring;`,
    "it can be out of date, so trust the code when the two disagree.",
    "<project-memory>",
    cut ? `${body.slice(0, MEMORY_INJECT_LIMIT)}\n… (truncated — read ${MEMORY_FILE} for the rest)` : body,
    "</project-memory>",
  ].join("\n")
}

/** Ce qu'on demande à l'agent chargé de l'écrire ou de la remettre à jour. */
export function memoryPrompt(exists: boolean): string {
  return [
    exists
      ? `Update ${MEMORY_FILE} at the project root: it is the project memory Zyvro Studio gives every new agent session at startup, and it may have drifted from the code.`
      : `Create ${MEMORY_FILE} at the project root: the project memory Zyvro Studio gives every new agent session at startup.`,
    "",
    "Explore the repository first: README, CLAUDE.md, AGENTS.md, CONTRIBUTING, package manifests, CI config, then the code itself.",
    "Check that commands exist rather than guessing them.",
    "",
    "The goal: a new agent reading only this file is productive in minutes. Factual, dense, under about 300 lines. Sections:",
    "1. What the project is, in one paragraph.",
    "2. Layout: the main directories and what lives where.",
    "3. Build, run, test and lint, with the exact commands.",
    "4. Architecture and key concepts: how the parts talk, where state lives.",
    "5. Conventions: style, naming, languages, commit and branch habits.",
    "6. Gotchas: non-obvious constraints and things that break silently.",
    "7. Where to start reading: the handful of files that explain the rest.",
    "",
    exists
      ? "Keep what is still true, fix what is wrong, drop what is gone, and keep any section the user clearly wrote by hand."
      : "",
    `Write only ${MEMORY_FILE}; do not change any other file. End with a short summary of what you wrote.`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n")
}
