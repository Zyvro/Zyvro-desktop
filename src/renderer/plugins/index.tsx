import { useSyncExternalStore } from "react"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { AGENT_PLUGINS, pluginOn, type PluginId } from "../../shared/plugins"
import type { TaskStatus } from "../../shared/tasks"
import { bugReportPlugin } from "./bugReport"
import { compactPlugin } from "./compact"
import { memoryPlugin } from "./memory"
import { permissionsPlugin } from "./permissions"
import { skillsPlugin } from "./skills"
import { speechPlugin, usagePlugin } from "./answers"
import { synthesisPlugin } from "./synthesis"
import { tasksPlugin } from "./tasks"
import { PackageButton, refreshPluginPackages, useRailPackages } from "./packages"
import type { AgentPlugin, AgentRailContext } from "./types"

export type { AgentPlugin, AgentRailContext } from "./types"

// Le registre : un module par entrée du catalogue (shared/plugins). Le type
// refuse un plugin oublié ; l'ordre, lui, est celui du catalogue.
const MODULES: Record<PluginId, AgentPlugin> = {
  tasks: tasksPlugin,
  memory: memoryPlugin,
  permissions: permissionsPlugin,
  synthesis: synthesisPlugin,
  skills: skillsPlugin,
  compact: compactPlugin,
  usage: usagePlugin,
  speech: speechPlugin,
  bugReport: bugReportPlugin,
}

export const pluginModule = (id: PluginId): AgentPlugin => MODULES[id]

export function pluginEnabled(id: PluginId): boolean {
  return pluginOn(getSettings().agent, id)
}

export function usePluginEnabled(id: PluginId): boolean {
  return useSyncExternalStore(subscribeSettings, () => pluginEnabled(id), () => true)
}

export function setPluginEnabled(id: PluginId, on: boolean): void {
  const agent = getSettings().agent
  updateSettings({ agent: { ...agent, plugins: { ...agent.plugins, [id]: on } } })
}

/** Un tour est fini : chaque plugin allumé qui veut le savoir l'apprend. */
export function pluginsTurnEnded(threadId: string, status: TaskStatus): void {
  for (const { id } of AGENT_PLUGINS) {
    if (pluginEnabled(id)) MODULES[id].turnEnded?.(threadId, status)
  }
  // L'agent a peut-être écrit ou corrigé un plugin du projet pendant ce tour
  // (Plugin Creator) : relus, ils apparaissent sans recharger l'app.
  refreshPluginPackages()
}

// AgentRail : la barre verticale à droite du chat, faite des plugins allumés.
//
// Des icônes seules — le nom et l'état sont dans l'infobulle — pour rendre la
// largeur au texte, en bas près de la boîte parce que c'est en écrivant qu'on y
// touche. Trois groupes, séparés d'un trait : ce qui est propre au projet (la
// file, la mémoire), ce qui gouverne la conversation, puis l'application. Les
// plugins en paquets (boutique, livrés, du projet) ont le leur, tout en haut :
// ce sont des actions qu'on lance, pas des réglages de la conversation.
export function AgentRail({ ctx }: { ctx: AgentRailContext }): JSX.Element | null {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const packages = useRailPackages()
  const shown = AGENT_PLUGINS.filter((p) => MODULES[p.id].Rail && pluginOn(settings.agent, p.id))
  const project = shown.filter((p) => p.section === "project")
  const rest = shown.filter((p) => p.section !== "project")
  // Tout éteint : pas de barre du tout, la largeur va au texte.
  if (shown.length === 0 && packages.length === 0) return null
  const render = (id: PluginId) => {
    const Rail = MODULES[id].Rail!
    return <Rail key={id} ctx={ctx} />
  }
  return (
    <div className="flex w-7 shrink-0 flex-col items-center justify-end gap-0.5 border-l border-white/[0.06] py-1.5" data-agent-rail>
      {packages.map((p) => <PackageButton key={p.name} plugin={p} ctx={ctx} />)}
      {packages.length > 0 && shown.length > 0 && <span className="my-1 h-px w-4 bg-white/[0.08]" aria-hidden />}
      {project.map((p) => render(p.id))}
      {project.length > 0 && rest.length > 0 && <span className="my-1 h-px w-4 bg-white/[0.08]" aria-hidden />}
      {rest.map((p) => render(p.id))}
    </div>
  )
}
