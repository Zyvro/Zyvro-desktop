// La mémoire d'un projet : un fichier, `ZYVRO.md` à la racine, que chaque
// nouvelle session d'agent reçoit au démarrage.
//
// Derrière, rien de plus qu'un Markdown qu'on peut lire, corriger et versionner.
// Ce que Zyvro y ajoute, c'est l'entretien : dire quand il manque ou a vieilli,
// lancer un agent qui explore le dépôt pour l'écrire, et l'injecter sans qu'on
// ait à y penser — quel que soit le harnais, y compris ceux qui ne lisent ni
// CLAUDE.md ni AGENTS.md.

export const MEMORY_FILE = "ZYVRO.md"

/**
 * Le fichier de mémoire se choisit, par projet : un dépôt qui tient déjà son
 * CLAUDE.md ou son AGENTS.md n'a pas à en écrire un troisième. Ceux-ci sont
 * proposés quand ils existent ; n'importe quel fichier texte du projet peut
 * être choisi.
 */
export const MEMORY_SUGGESTIONS = ["ZYVRO.md", "CLAUDE.md", "AGENTS.md", "QWEN.md", "GEMINI.md", ".github/copilot-instructions.md", "README.md"]

/** Un chemin de mémoire acceptable : relatif au projet, sans en sortir. */
export function memoryFileOk(rel: unknown): rel is string {
  if (typeof rel !== "string") return false
  const clean = rel.trim()
  if (!clean || clean.length > 300 || clean.includes("\0")) return false
  if (/^([a-zA-Z]:)?[\\/]/.test(clean)) return false
  return !clean.split(/[\\/]/).some((part) => part === "..")
}

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
  /** Le fichier de mémoire de ce projet, relatif à sa racine. */
  file: string
  /** Les fichiers proposés (MEMORY_SUGGESTIONS) qui existent dans ce projet. */
  candidates: string[]
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
export function memoryPreamble(text: string | null, file = MEMORY_FILE): string {
  const body = text?.trim() ?? ""
  if (!body) return ""
  const cut = body.length > MEMORY_INJECT_LIMIT
  return [
    "",
    `Project memory (${file} in the project, maintained with Zyvro Studio). Read it before exploring;`,
    "it can be out of date, so trust the code when the two disagree.",
    "<project-memory>",
    cut ? `${body.slice(0, MEMORY_INJECT_LIMIT)}\n… (truncated — read ${file} for the rest)` : body,
    "</project-memory>",
  ].join("\n")
}

/** Ce qu'on demande à l'agent chargé de l'écrire ou de la remettre à jour. */
export function memoryPrompt(exists: boolean, file = MEMORY_FILE): string {
  return [
    exists
      ? `Update ${file} in the project: it is the project memory Zyvro Studio gives every new agent session at startup, and it may have drifted from the code.`
      : `Create ${file} in the project: the project memory Zyvro Studio gives every new agent session at startup.`,
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
    `Write only ${file}; do not change any other file. End with a short summary of what you wrote.`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n")
}
