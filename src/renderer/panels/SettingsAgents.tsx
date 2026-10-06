import { useSyncExternalStore } from "react"
import { KeyRound } from "lucide-react"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { permission, setPermission, subscribePermission } from "~/state/permission"
import { useHarnessesInstalled } from "~/lib/harnessInstall"
import { useWorkspace } from "~/state/workspace"
import { HarnessPicker } from "./HarnessPicker"
import { ModelPicker } from "./ModelPicker"
import { PermissionPicker } from "./PermissionPicker"

export function SettingRow({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] py-4">
    <div className="min-w-0 flex-1 basis-48"><p className="text-[13px] font-medium">{title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p></div>
    <div className="max-w-full shrink-0">{children}</div>
  </div>
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-sky-400 disabled:opacity-40" />
}

export function SettingsAgents({ permissionsOnly = false }: { permissionsOnly?: boolean }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const access = useSyncExternalStore(subscribePermission, permission)
  const installed = useHarnessesInstalled()
  const a = settings.agent
  if (permissionsOnly) return <>
    <SettingRow title="Agent permissions" hint="Your current permission level, shared with the chat toolbar. Applies across projects; changing it affects the next turn.">
      <PermissionPicker kind={a.defaultKind} value={access} onChange={setPermission} />
    </SettingRow>
    <p className="mt-5 text-xs leading-relaxed text-muted-foreground">Skills follow the agent's permissions. Enabling a skill does not grant additional access. Each agent translates this level into its own supported permission controls.</p>
  </>
  return <>
    <SettingRow title="Default agent" hint="Used when you create a new chat. Existing conversations keep their agent.">
      <HarnessPicker kind={a.defaultKind} installed={(kind) => installed.data?.harnesses[kind] ?? true} onChange={(defaultKind) => updateSettings({ agent: { ...a, defaultKind } })} />
    </SettingRow>
    <SettingRow title="Default model" hint="Remembered separately for each agent. You can still change the model in a conversation.">
      <ModelPicker kind={a.defaultKind} model={a.defaultModels[a.defaultKind] ?? null} ranWith={null} onChange={(model) => updateSettings({ agent: { ...a, defaultModels: { ...a.defaultModels, [a.defaultKind]: model } } })} />
    </SettingRow>
    <button onClick={() => useWorkspace.getState().openProviders()} className="mt-6 flex items-center gap-2 rounded-lg border border-white/10 p-3 text-sm hover:bg-white/5"><KeyRound className="h-4 w-4" />Providers and API keys</button>
  </>
}
