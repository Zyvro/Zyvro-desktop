import { useSyncExternalStore } from "react"
import { getSettings, subscribeSettings } from "~/state/settings"
import { pluginModule, setPluginEnabled } from "~/plugins"
import { AGENT_PLUGINS, pluginOn, type PluginSection } from "../../shared/plugins"
import { Toggle } from "./SettingsAgents"
import { PackageSettings } from "~/plugins/packages"

// Settings › Plugins : les fonctions de l'agent, une par une (shared/plugins).
//
// Chaque plugin dit ce qu'il fait et, juste dessous, ce qui se passe quand on
// l'éteint : « éteindre la mémoire » ne dit pas si ZYVRO.md est effacé, et
// c'est exactement la question qu'on se pose avant de cliquer. Ses réglages
// propres suivent, seulement quand il est allumé.

const SECTIONS: { id: PluginSection; title: string }[] = [
  { id: "project", title: "Project" },
  { id: "conversation", title: "Conversation" },
  { id: "answers", title: "Answers" },
  { id: "app", title: "App" },
]

export function SettingsPlugins(): JSX.Element {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  return <>
    <p className="mb-2 text-xs leading-relaxed text-muted-foreground">Each agent feature is a plugin. Turning one off hides it and stops what it does; nothing it saved is deleted.</p>
    {SECTIONS.map((section) => (
      <section key={section.id} className="mt-5">
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{section.title}</h3>
        {AGENT_PLUGINS.filter((p) => p.section === section.id).map((plugin) => {
          const on = pluginOn(settings.agent, plugin.id)
          const Settings = pluginModule(plugin.id).Settings
          return (
            <div key={plugin.id} className="border-b border-white/[0.06] py-4" data-plugin={plugin.id}>
              <label className="flex cursor-pointer items-start justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{plugin.name}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{plugin.description}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground/70">Off: {plugin.whenOff}</span>
                </span>
                <Toggle label={`Enable ${plugin.name}`} checked={on} onChange={(next) => setPluginEnabled(plugin.id, next)} />
              </label>
              {on && Settings && <div className="mt-2 border-l border-white/[0.08] pl-4"><Settings /></div>}
            </div>
          )
        })}
      </section>
    ))}
    <PackageSettings />
  </>
}
