import { useSyncExternalStore } from "react"
import { Plus, Trash2 } from "lucide-react"
import { EFFORTS, MAX_PROFILES, defaultProfile, supportsEffort, type AgentProfile, type Effort } from "../../shared/agentShell"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { useHarnessesInstalled } from "~/lib/harnessInstall"
import { HarnessPicker } from "./HarnessPicker"
import { ModelPicker } from "./ModelPicker"
import { SettingRow, Toggle } from "./SettingsAgents"

// Les configurations d'agent du panneau Shell + Agents (shared/agentShell).
//
// Un profil est ce que le lanceur règle : harnais, modèle, permission, effort,
// instructions, outils Zyvro. Les profils s'ouvrent depuis le menu de l'agent
// dans la barre des onglets du terminal, ou se chargent dans le lanceur.

const field =
  "h-8 rounded-md border border-white/10 bg-white/[0.03] px-2 text-[12px] outline-none focus:border-primary/50"

export function SettingsProfiles() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const installed = useHarnessesInstalled()
  const agent = settings.agent
  const { profiles } = agent

  const save = (next: AgentProfile[], defaultProfile = agent.defaultProfile): void =>
    updateSettings({ agent: { ...agent, profiles: next, defaultProfile } })
  const change = (id: string, patch: Partial<AgentProfile>): void =>
    save(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const add = (): void => {
    const base = defaultProfile(agent.defaultKind)
    save([...profiles, { ...base, id: `profile-${Date.now().toString(36)}`, name: "New profile" }])
  }

  return (
    <>
      <SettingRow
        title="Reopen agents at startup"
        hint="Agents that were open when Zyvro closed come back in their tabs, resuming the same conversation. Plain shells stay closed."
      >
        <Toggle
          label="Reopen agents at startup"
          checked={agent.restoreAgentShells}
          onChange={(restoreAgentShells) => updateSettings({ agent: { ...agent, restoreAgentShells } })}
        />
      </SettingRow>

      <SettingRow
        title="Keep agents running when Zyvro quits"
        hint="Agents run in a small background host instead of inside the app: quitting or updating Zyvro detaches from them and they keep working. When Zyvro opens again it reattaches and replays their screen. Closing an agent's tab still stops it."
      >
        <Toggle
          label="Keep agents running when Zyvro quits"
          checked={agent.detachAgents}
          onChange={(detachAgents) => updateSettings({ agent: { ...agent, detachAgents } })}
        />
      </SettingRow>

      <SettingRow
        title="Agent profiles"
        hint="Saved configurations for the Shell + Agents launcher: harness, model, effort, extra instructions and tools. Permission and skills are not part of a profile: they are set once in the right-hand bar and apply to every agent you start."
      >
        <button
          type="button"
          disabled={profiles.length >= MAX_PROFILES}
          onClick={add}
          className="flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs hover:bg-white/5 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add profile
        </button>
      </SettingRow>

      <div className="space-y-3 pt-3">
        {profiles.map((profile) => (
          <div key={profile.id} className="space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Profile name"
                className={`${field} min-w-[8rem] flex-1`}
                value={profile.name}
                maxLength={60}
                onChange={(e) => change(profile.id, { name: e.target.value })}
              />
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="radio"
                  name="default-profile"
                  className="accent-sky-400"
                  checked={(agent.defaultProfile ?? profiles[0]?.id) === profile.id}
                  onChange={() => save(profiles, profile.id)}
                />
                Launcher default
              </label>
              <button
                type="button"
                disabled={profiles.length <= 1}
                onClick={() => save(profiles.filter((p) => p.id !== profile.id))}
                title="Delete this profile"
                aria-label="Delete this profile"
                className="rounded p-1.5 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <HarnessPicker
                kind={profile.kind}
                installed={(kind) => installed.data?.harnesses[kind] ?? true}
                onChange={(kind) => change(profile.id, { kind, model: null, effort: null })}
              />
              <div className="min-w-0 max-w-[12rem]">
                <ModelPicker kind={profile.kind} model={profile.model} ranWith={null} onChange={(model) => change(profile.id, { model })} />
              </div>
              {supportsEffort(profile.kind) && (
                <select
                  aria-label="Reasoning effort"
                  className={field}
                  value={profile.effort ?? ""}
                  onChange={(e) => change(profile.id, { effort: e.target.value === "" ? null : (e.target.value as Effort) })}
                >
                  <option value="">effort: default</option>
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      effort: {effort}
                    </option>
                  ))}
                </select>
              )}
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Toggle label="Zyvro tools" checked={profile.mcp} onChange={(mcp) => change(profile.id, { mcp })} />
                Zyvro tools
              </label>
            </div>
            <textarea
              aria-label="Extra instructions"
              rows={2}
              maxLength={8000}
              value={profile.instructions}
              onChange={(e) => change(profile.id, { instructions: e.target.value })}
              placeholder="Extra instructions for this agent (optional) — added to its system prompt when the harness takes one, otherwise to the first task."
              className="w-full resize-y rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/70 focus:border-primary/50"
            />
          </div>
        ))}
      </div>
    </>
  )
}
