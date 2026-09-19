// Ce que git est en train de faire, pour tout le monde en même temps.
//
// Demandé par Jeremy : « quand je push je ne vois pas assez bien que le push
// est en cours, c'est important de savoir visuellement ce qui se passe ». Il a
// raison, et le défaut était structurel plutôt que graphique.
//
// Un push part de trois endroits — le bouton de commit, la pastille de la barre
// d'état, le menu — et chacun tenait son propre `useMutation`. Celui qui lançait
// savait ; les deux autres ne savaient rien. Lancer un push depuis le menu ne
// montrait donc rien du tout, et la pastille de la barre — le seul endroit
// toujours visible — ne bougeait que si c'est de là qu'on était parti.
//
// Une opération à la fois, ici, et les trois la lisent. Ce n'est pas un choix
// d'affichage : git prend un verrou sur le dépôt, donc deux opérations
// simultanées n'existent pas.
//
// Et le verbe plutôt qu'un tourniquet seul. Un rond qui tourne dit « attends » ;
// « Pushing… » dit ce qu'on attend, ce qui est la différence entre patienter et
// se demander si on a cliqué.

export type GitRunning = {
  /** Ce qui se passe : « Pushing », « Pulling »… Vide quand rien ne tourne. */
  verb: string
  /** Vrai quand c'est fini et qu'on l'annonce une seconde avant de se taire. */
  done: boolean
  /** Vrai quand ça s'est mal passé : l'annonce reste, et elle est rouge. */
  failed: boolean
}

const IDLE: GitRunning = { verb: "", done: false, failed: false }

let state: GitRunning = IDLE
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function set(next: GitRunning): void {
  state = next
  for (const listener of listeners) listener()
}

function clearLater(ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    set(IDLE)
  }, ms)
}

/** Une opération commence. */
export function gitStarted(verb: string): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  set({ verb, done: false, failed: false })
}

/**
 * Une opération finit.
 *
 * L'annonce reste un instant : un push qui dure trois secondes et disparaît
 * sans un mot laisse exactement le doute qu'on essaie d'enlever — « est-ce que
 * c'est parti ? ». Deux secondes suffisent à le lire, et un échec reste plus
 * longtemps parce qu'il y a quelque chose à faire.
 */
export function gitFinished(verb: string, failed: boolean): void {
  set({ verb, done: true, failed })
  clearLater(failed ? 6000 : 2000)
}

export function gitRunning(): GitRunning {
  return state
}

export function subscribeGit(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Le nom de ce qui se passe, au présent puis au passé.
 *
 * Écrit ici et pas dans les composants : les trois surfaces doivent dire le
 * même mot, et un troisième endroit qui traduit « push » en français
 * approximatif serait le troisième à corriger le jour où l'on en ajoute un.
 */
export const GIT_VERBS: Record<string, { now: string; then: string }> = {
  push: { now: "Pushing", then: "Pushed" },
  pull: { now: "Pulling", then: "Pulled" },
  fetch: { now: "Fetching", then: "Fetched" },
  commit: { now: "Committing", then: "Committed" },
  checkout: { now: "Switching", then: "Switched" },
  createBranch: { now: "Creating", then: "Created" },
  init: { now: "Starting a repository", then: "Repository started" },
  stage: { now: "Staging", then: "Staged" },
  unstage: { now: "Unstaging", then: "Unstaged" },
  discard: { now: "Discarding", then: "Discarded" },
}
