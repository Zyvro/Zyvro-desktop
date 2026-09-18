// Ce qu'une réponse a coûté, et le droit de ne pas le voir.
//
// Les chiffres viennent avec le flux du CLI : les afficher ne demande rien à
// personne et ne dépense rien. C'est pour ça que c'est allumé par défaut, à
// l'inverse de la complétion en ligne, qui part à chaque silence de frappe et
// doit donc être allumée à la main.
//
// Et c'est un réglage parce qu'une ligne de chiffres sous chaque réponse est
// utile un jour et bavarde le lendemain. La préférence vit dans le navigateur
// de l'application : elle est propre à cette machine, pas au projet.

const STORAGE_KEY = "zyvro.usage.shown"

let shown = read()
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    // Absent veut dire « oui » : c'est ce qu'on a demandé en écrivant ceci, et
    // seul un refus explicite l'éteint.
    return window.localStorage.getItem(STORAGE_KEY) !== "off"
  } catch {
    // Un stockage refusé n'est pas une raison de perdre l'information.
    return true
  }
}

export function usageShown(): boolean {
  return shown
}

export function setUsageShown(on: boolean): void {
  shown = on
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off")
  } catch {
    // Tant pis pour la mémoire : le choix vaut pour cette session.
  }
  for (const listener of listeners) listener()
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// compact abrège un nombre de jetons sans mentir sur son ordre de grandeur.
//
// Vingt-sept mille jetons s'écrivent « 27k » : le chiffre exact n'apprend rien
// à personne, et une ligne d'information qui pousse le reste de la réponse est
// une information qui gêne. L'exact reste dans l'infobulle.
export function compact(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

// detail : ce que l'infobulle dit, et d'où viennent les jetons d'entrée.
//
// La distinction n'est pas cosmétique : relire un contexte depuis le cache
// coûte une fraction de ce que coûte le faire lire pour la première fois. Une
// entrée de vingt-sept mille dont vingt-six mille relus n'est pas la même
// dépense qu'une entrée de vingt-sept mille jetons frais.
export function detail(spent: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number | null
}): string {
  const fresh = spent.input - spent.cacheRead - spent.cacheWrite
  const lignes = [
    `${spent.input.toLocaleString("en-US")} tokens in, ${spent.output.toLocaleString("en-US")} out`,
    `  ${fresh.toLocaleString("en-US")} new`,
  ]
  if (spent.cacheRead > 0) lignes.push(`  ${spent.cacheRead.toLocaleString("en-US")} read from cache`)
  if (spent.cacheWrite > 0) lignes.push(`  ${spent.cacheWrite.toLocaleString("en-US")} written to cache`)
  if (spent.costUsd !== null) lignes.push(`$${spent.costUsd.toFixed(4)} at API prices`)
  return lignes.join("\n")
}
