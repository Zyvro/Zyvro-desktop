// Ce qu'une réponse a coûté, et le droit de ne pas le voir.
//
// Les chiffres viennent avec le flux du CLI : les afficher ne demande rien à
// personne et ne dépense rien. C'est pour ça que c'est allumé par défaut, à
// l'inverse de la complétion en ligne, qui part à chaque silence de frappe et
// doit donc être allumée à la main.
//
// Et c'est un réglage parce qu'une ligne de chiffres sous chaque réponse est
// utile un jour et bavarde le lendemain. C'est le plugin « Token usage »
// (shared/plugins) : il vit dans les réglages de l'agent, propres à cette
// machine, avec les autres fonctions qu'on allume ou qu'on éteint. L'ancienne
// clé, `zyvro.usage.shown`, est reprise une fois par state/settings.

import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { pluginOn } from "../../shared/plugins"

export function usageShown(): boolean {
  return pluginOn(getSettings().agent, "usage")
}

export function setUsageShown(on: boolean): void {
  const agent = getSettings().agent
  updateSettings({ agent: { ...agent, plugins: { ...agent.plugins, usage: on } } })
}

export const subscribeUsage = subscribeSettings

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
