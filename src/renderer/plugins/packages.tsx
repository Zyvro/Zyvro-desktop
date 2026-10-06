import { useState, useSyncExternalStore } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import * as Dialog from "@radix-ui/react-dialog"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { BookOpen, Bug, Code2, Loader2, PenLine, Puzzle, Rocket, Sparkles, Store, Trash2, Wand2, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { queryClient } from "~/lib/queryClient"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { useWorkspace } from "~/state/workspace"
import { RAIL_BUTTON, RAIL_MENU } from "~/panels/railButton"
import { Toggle } from "~/panels/SettingsAgents"
import { actionPrompt, type PluginAction, type PluginIcon } from "../../shared/pluginPackage"
import type { LoadedPlugin } from "../../preload"
import type { AgentRailContext } from "./types"

// Les plugins en paquets (shared/pluginPackage) côté rendu : livrés avec l'app,
// installés depuis la boutique, ou en cours d'écriture dans le projet.
//
// Ils n'ont pas de module ici, et c'est voulu : un paquet n'apporte pas de code,
// seulement des actions et des skills. Ce fichier est l'hôte unique qui les
// dessine — un bouton par plugin dans la barre de droite du chat, et leur ligne
// dans Settings › Plugins.

export const ICONS: Record<PluginIcon, LucideIcon> = {
  puzzle: Puzzle,
  sparkles: Sparkles,
  wand: Wand2,
  book: BookOpen,
  bug: Bug,
  rocket: Rocket,
  code: Code2,
  pen: PenLine,
}

export const packagesKey = (root: string | null) => ["agent-plugins", root] as const

export function usePluginPackages() {
  const root = useWorkspace((s) => s.root)
  return useQuery({ queryKey: packagesKey(root), queryFn: () => window.zyvro.plugins.list() })
}

/**
 * Relire les plugins : après une installation, et après chaque tour — l'agent
 * vient peut-être d'écrire ou de corriger un plugin du projet, et on veut le
 * voir apparaître sans recharger quoi que ce soit.
 */
export function refreshPluginPackages(): void {
  void queryClient.invalidateQueries({ queryKey: ["agent-plugins"] })
}

export function packageEnabled(name: string): boolean {
  return !getSettings().agent.disabledPlugins.includes(name)
}

export function setPackageEnabled(name: string, on: boolean): void {
  const agent = getSettings().agent
  const rest = agent.disabledPlugins.filter((n) => n !== name)
  updateSettings({ agent: { ...agent, disabledPlugins: on ? rest : [...rest, name] } })
}

/** Les plugins allumés qui ont au moins une action : ceux qui ont un bouton. */
export function useRailPackages(): LoadedPlugin[] {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const list = usePluginPackages()
  return (list.data?.plugins ?? []).filter((p) => p.actions.length > 0 && !settings.agent.disabledPlugins.includes(p.name))
}

const ORIGIN_LABEL: Record<LoadedPlugin["origin"], string> = {
  bundled: "Built in",
  installed: "From the store",
  project: "This project",
}

// PackageButton : l'icône d'un plugin dans la barre. Une seule action part
// directement (ou ouvre sa question) ; plusieurs s'ouvrent en menu.
export function PackageButton({ plugin, ctx }: { plugin: LoadedPlugin; ctx: AgentRailContext }): JSX.Element {
  const [asking, setAsking] = useState<PluginAction | null>(null)
  const Icon = ICONS[plugin.icon] ?? Puzzle
  const run = (action: PluginAction, input = "") => {
    const skills = plugin.skills.map((s) => ({ name: s.name, description: s.description, file: s.file }))
    ctx.actions.runInThread(`${plugin.name}: ${action.label}`, actionPrompt(plugin, action, input, skills))
  }
  const choose = (action: PluginAction) => (action.input ? setAsking(action) : run(action))
  const title = plugin.actions.length === 1 ? `${plugin.actions[0].label} (${plugin.name})` : plugin.name
  const button = cn(RAIL_BUTTON, "text-muted-foreground hover:text-foreground")

  return (
    <>
      {plugin.actions.length === 1 ? (
        <button type="button" aria-label={title} title={title} disabled={ctx.disabled} className={button} data-plugin-package={plugin.name} onClick={() => choose(plugin.actions[0])}>
          <Icon className="h-3.5 w-3.5" />
        </button>
      ) : (
        <Menu.Root>
          <Menu.Trigger aria-label={title} title={title} disabled={ctx.disabled} className={button} data-plugin-package={plugin.name}>
            <Icon className="h-3.5 w-3.5" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content {...RAIL_MENU} className="panel zy-scroll z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-72 overflow-y-auto p-2">
              <p className="px-2 py-1 text-xs font-medium">{plugin.name}</p>
              {plugin.actions.map((action) => (
                <Menu.Item key={action.id} onSelect={() => choose(action)} className="cursor-default rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-white/10">
                  <span className="block">{action.label}{action.input ? "…" : ""}</span>
                  {action.description && <span className="mt-0.5 block text-[11px] text-muted-foreground">{action.description}</span>}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      )}
      {asking && (
        <ActionDialog
          plugin={plugin}
          action={asking}
          onClose={() => setAsking(null)}
          onRun={(input) => {
            setAsking(null)
            run(asking, input)
          }}
        />
      )}
    </>
  )
}

function ActionDialog({ plugin, action, onClose, onRun }: {
  plugin: LoadedPlugin
  action: PluginAction
  onClose: () => void
  onRun: (input: string) => void
}): JSX.Element {
  const [input, setInput] = useState("")
  const Icon = ICONS[plugin.icon] ?? Puzzle
  const ready = input.trim() !== ""
  const submit = () => {
    if (ready) onRun(input)
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="panel fixed left-1/2 top-1/4 z-50 w-[520px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5" data-plugin-dialog={plugin.name}>
          <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
            <Icon className="h-4 w-4 text-violet-300" />
            {action.label}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
            {action.description || plugin.description}
            {action.skills === "all" && plugin.skills.length > 0 && ` The agent will first read the plugin's ${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}.`}
            {" "}It runs in a new conversation, with your current permission level.
          </Dialog.Description>
          <label className="mt-3 block text-[12px] font-medium">{action.input?.label}</label>
          <textarea
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                submit()
              }
            }}
            placeholder={action.input?.placeholder}
            rows={6}
            className="mt-1.5 w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-white/[0.12] px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground">
              Cancel
            </button>
            <button type="button" disabled={!ready} onClick={submit} className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40">
              Start
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// PackageSettings : les plugins en paquets dans Settings › Plugins. Chacun dit
// d'où il vient, ce qu'il apporte, et peut s'éteindre ; ceux de la boutique se
// désinstallent. Un dossier qui n'est pas un plugin valable est montré avec la
// raison — c'est ici que l'auteur d'un plugin, souvent l'agent, voit pourquoi le
// sien ne se charge pas.
export function PackageSettings(): JSX.Element {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const list = usePluginPackages()
  const uninstall = useMutation({
    mutationFn: (name: string) => window.zyvro.plugins.uninstall(name),
    onSettled: refreshPluginPackages,
  })
  const plugins = list.data?.plugins ?? []
  const problems = list.data?.problems ?? []
  return (
    <section className="mt-5" data-plugin-packages>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Installed plugins</h3>
        <button type="button" onClick={() => useWorkspace.getState().openStore()} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <Store className="h-3 w-3" /> Browse the store
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Plugins from the store, the ones built in, and the ones this project is writing in .zyvro/plugins. They add buttons beside the chat and skills for the agent; they run no code of their own.
      </p>
      {list.isLoading && <p className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 zy-spin" /> Reading plugins…</p>}
      {list.error && <p role="alert" className="py-3 text-xs text-red-300">{(list.error as Error).message}</p>}
      {plugins.map((plugin) => {
        const on = !settings.agent.disabledPlugins.includes(plugin.name)
        const Icon = ICONS[plugin.icon] ?? Puzzle
        return (
          <div key={plugin.name} className="border-b border-white/[0.06] py-4" data-plugin-package-row={plugin.name}>
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {plugin.name}
                  <span className="font-mono text-[11px] font-normal text-muted-foreground">{plugin.version}</span>
                  <span className="rounded bg-white/[0.07] px-1 py-px text-[10px] font-normal text-muted-foreground">{ORIGIN_LABEL[plugin.origin]}</span>
                </span>
                {plugin.description && <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{plugin.description}</span>}
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground/70">
                  {plugin.actions.length > 0 && `Actions: ${plugin.actions.map((a) => a.label).join(", ")}. `}
                  {plugin.skills.length > 0 && `Skills: ${plugin.skills.map((s) => s.name).join(", ")}.`}
                </span>
                {plugin.shadows.length > 0 && (
                  <span className="mt-1 block text-[11px] text-amber-200/80">
                    Also present as {plugin.shadows.map((o) => ORIGIN_LABEL[o].toLowerCase()).join(" and ")}; this copy is the one in use.
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2">
                {plugin.origin === "installed" && (
                  <button
                    type="button"
                    title={`Uninstall ${plugin.name}`}
                    aria-label={`Uninstall ${plugin.name}`}
                    disabled={uninstall.isPending}
                    onClick={() => uninstall.mutate(plugin.name)}
                    className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-red-300 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
                <Toggle label={`Enable ${plugin.name}`} checked={on} onChange={(next) => setPackageEnabled(plugin.name, next)} />
              </div>
            </div>
          </div>
        )
      })}
      {problems.map((problem) => (
        <div key={problem.dir} className="border-b border-white/[0.06] py-3" data-plugin-problem={problem.name}>
          <p className="text-[13px] font-medium">{problem.name} <span className="text-[10px] font-normal text-muted-foreground">{ORIGIN_LABEL[problem.origin]}</span></p>
          <p className="mt-1 break-words text-xs text-red-300">Not loaded: {problem.error}</p>
          <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{problem.dir}</p>
        </div>
      ))}
      {uninstall.error && <p role="alert" className="mt-2 text-xs text-red-300">{(uninstall.error as Error).message}</p>}
    </section>
  )
}
