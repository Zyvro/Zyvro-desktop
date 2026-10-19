import { useSyncExternalStore } from "react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Bookmark, Check, ChevronDown, ChevronRight, Plug, Sparkles, TerminalSquare } from "lucide-react"
import { cn } from "@/lib/utils"
import { EFFORTS, supportsEffort, type AgentProfile, type Effort } from "../../shared/agentShell"
import { HARNESSES, type AgentKind } from "../../shared/harness"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import {
  applyProfile,
  getLauncher,
  launcherSpec,
  runLauncher,
  setLauncher,
  subscribeLauncher,
} from "~/state/launcher"
import { askName } from "~/state/prompt"
import { handTo, subscribeHandoff, takeHandoff, tokenOf } from "~/state/handoff"
import { askAgent } from "~/state/persistent"
import { useWorkspace } from "~/state/workspace"
import { useRef } from "react"
import { isAbsolutePath } from "../../shared/external"
import { droppedText } from "../../shared/dropped"
import { installHarness, useHarnessesInstalled } from "~/lib/harnessInstall"
import { HarnessPicker } from "./HarnessPicker"
import { ModelPicker } from "./ModelPicker"

// Le lanceur de la barre « Shell + Agents ».
//
// On choisit une configuration d'agent — celle d'un profil, ou réglée à la main
// avec les mêmes sélecteurs que le panneau de chat —, on écrit la tâche, on
// lance : ce qui s'ouvre est le harnais dans son interface native, dans un
// onglet du terminal, avec tout ce qui a été choisi traduit en drapeaux
// (shared/agentShell). Pas de zone de saisie ici : la tâche se tape dans le
// harnais lui-même, qui a la sienne. La permission et les skills se règlent
// dans la barre latérale droite, une seule fois.

const chip =
  "flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] outline-none transition-colors disabled:opacity-40"
const chipOff = "border-white/[0.08] bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
const chipOn = "border-sky-400/40 bg-sky-400/10 text-sky-200 hover:bg-sky-400/15"

function EffortPicker({ kind, value, onChange }: { kind: AgentKind; value: Effort | null; onChange: (e: Effort | null) => void }) {
  if (!supportsEffort(kind)) return null
  return (
    <select
      aria-label="Reasoning effort"
      title="Reasoning effort — the harness default when unset"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as Effort))}
      className="h-[26px] rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 text-[11px] text-foreground outline-none hover:bg-white/[0.08]"
    >
      <option value="">effort: default</option>
      {EFFORTS.map((effort) => (
        <option key={effort} value={effort}>
          effort: {effort}
        </option>
      ))}
    </select>
  )
}

function ProfileMenu({ profiles, current }: { profiles: AgentProfile[]; current: string | null }) {
  const active = profiles.find((p) => p.id === current)
  return (
    <Menu.Root>
      <Menu.Trigger
        title="Load a saved agent configuration"
        className={cn(chip, chipOff, "max-w-[9rem]", "data-[state=open]:bg-white/[0.08]")}
      >
        <Bookmark className="h-3 w-3 shrink-0" />
        <span className="truncate">{active ? active.name : "Custom"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="panel zy-scroll z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[220px] overflow-y-auto p-1"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          {profiles.map((profile) => (
            <Menu.Item
              key={profile.id}
              onSelect={() => applyProfile(profile)}
              className="flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-white/[0.09]"
            >
              <Check className={cn("h-3 w-3 shrink-0", profile.id === current ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{profile.name}</span>
                <span className="block truncate text-[10.5px] text-muted-foreground">
                  {profile.kind}
                  {profile.model ? ` · ${profile.model}` : ""} · {profile.permission}
                </span>
              </span>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

export function AgentLauncher(): JSX.Element {
  const state = useSyncExternalStore(subscribeLauncher, getLauncher)
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const installed = useHarnessesInstalled()
  const profiles = settings.agent.profiles

  // Ce que l'arbre ou les réglages remettent « à l'agent ». Un chemin est écrit
  // dans le shell actif, cité comme un fichier déposé et sans Entrée : on
  // continue la phrase que le harnais attend. Une demande entière (« prépare ce
  // pack de skills ») lance un agent avec cette tâche.
  //
  // Pris APRÈS le rendu : en développement React rend deux fois, et une prise
  // pendant le rendu serait consommée par le passage jeté.
  const remis = useSyncExternalStore(subscribeHandoff("agent"), () => tokenOf("agent"), () => 0)
  const attendait = useRef(0)
  if (remis !== attendait.current) {
    attendait.current = remis
    window.queueMicrotask(() => {
      const texte = takeHandoff("agent")
      if (!texte) return
      useWorkspace.getState().setPanel("terminal", true)
      if (isAbsolutePath(texte) && !texte.includes("\n")) handTo("terminal", `${droppedText([texte], window.zyvro.platform)}`)
      else askAgent(launcherSpec(texte))
    })
  }
  const present = installed.data?.harnesses[state.kind] ?? true

  // Toute retouche à la main détache le profil : le nom afficherait sinon une
  // configuration que ce n'est plus.
  const tweak = (patch: Parameters<typeof setLauncher>[0]): void => setLauncher({ ...patch, profileId: null })

  if (!state.open) {
    return (
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-white/[0.06] px-2">
        <button
          type="button"
          onClick={() => setLauncher({ open: true })}
          className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          title="Run an agent in a shell — pick its configuration, write the task, go"
        >
          <ChevronRight className="h-3 w-3 shrink-0" />
          <Sparkles className="h-3 w-3 shrink-0" />
          <span className="truncate">
            Run an agent · {state.kind}
            {state.model ? ` · ${state.model}` : ""} · {state.permission}
          </span>
        </button>
      </div>
    )
  }

  const saveProfile = async (): Promise<void> => {
    const name = await askName({
      title: "Save agent configuration",
      label: `${state.kind}${state.model ? ` · ${state.model}` : ""} · ${state.permission}`,
      confirmLabel: "Save",
    })
    const clean = name?.trim().slice(0, 60)
    if (!clean) return
    const id = `profile-${Date.now().toString(36)}`
    const profile: AgentProfile = {
      id,
      name: clean,
      kind: state.kind,
      model: state.model,
      permission: state.permission,
      effort: state.effort,
      instructions: state.instructions,
      mcp: state.mcp,
      skills: state.skills,
    }
    const agent = getSettings().agent
    updateSettings({ agent: { ...agent, profiles: [...agent.profiles, profile] } })
    setLauncher({ profileId: id })
  }

  return (
    <div className="shrink-0 border-b border-white/[0.06] bg-white/[0.02] px-2 py-1.5" data-agent-launcher>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setLauncher({ open: false })}
          className="rounded p-0.5 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          title="Collapse the launcher"
          aria-label="Collapse the launcher"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <ProfileMenu profiles={profiles} current={state.profileId} />
        <HarnessPicker
          kind={state.kind}
          installed={(kind) => installed.data?.harnesses[kind] ?? true}
          onChange={(kind) =>
            tweak({ kind, model: settings.agent.defaultModels[kind] ?? null, effort: null })
          }
        />
        <div className="min-w-0 max-w-[11rem]">
          <ModelPicker kind={state.kind} model={state.model} ranWith={null} onChange={(model) => tweak({ model })} />
        </div>
        <EffortPicker kind={state.kind} value={state.effort} onChange={(effort) => tweak({ effort })} />
        <button
          type="button"
          onClick={() => tweak({ mcp: !state.mcp })}
          className={cn(chip, state.mcp ? chipOn : chipOff)}
          title="Wire this project's Zyvro tools (workflows, capture) into the agent over MCP"
          aria-pressed={state.mcp}
        >
          <Plug className="h-3 w-3" />
          Zyvro tools
        </button>
        {state.profileId === null && (
          <button
            type="button"
            onClick={() => void saveProfile()}
            className={cn(chip, chipOff)}
            title="Save this configuration as a profile"
          >
            <Bookmark className="h-3 w-3" />
            Save
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!present}
          onClick={() => runLauncher()}
          className="flex items-center gap-1 rounded-md border border-white/[0.1] px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-white/[0.08] disabled:opacity-40"
          title="Open the agent on its own prompt"
        >
          <TerminalSquare className="h-3 w-3" />
          Empty
        </button>
      </div>

      {!present && (
        <div className="mt-1.5 flex items-center gap-2 rounded border border-amber-300/20 bg-amber-300/[0.06] px-2 py-1 text-[11px] text-amber-200">
          <span className="min-w-0 flex-1 truncate">
            {HARNESSES[state.kind].bin} is not installed on this machine.
          </span>
          <button
            type="button"
            onClick={() => installHarness(state.kind)}
            className="shrink-0 rounded border border-amber-300/30 px-1.5 py-0.5 hover:bg-amber-300/10"
          >
            Install
          </button>
        </div>
      )}

    </div>
  )
}
