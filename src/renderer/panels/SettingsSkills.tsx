import { useState, useSyncExternalStore } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Download, RefreshCw } from "lucide-react"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { useWorkspace } from "~/state/workspace"
import { useSettingsPage } from "~/state/settingsPage"
import { handTo } from "~/state/handoff"
import { AGENT_KINDS, type AgentKind } from "../../shared/harness"
import { skillEnabled, type SkillPack } from "../../shared/skills"
import { HARNESS_INFO } from "./HarnessPicker"
import { pluginOn } from "../../shared/plugins"
import { SettingRow, Toggle } from "./SettingsAgents"

export const skillsKey = (root: string | null, kind: AgentKind) => ["agent", "skills", root, kind] as const

export function SettingsSkills() {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const root = useWorkspace((s) => s.root)
  const selectedKind = useSettingsPage((s) => s.skillsKind)
  const setKind = useSettingsPage((s) => s.selectSkills)
  const kind = selectedKind ?? settings.agent.defaultKind
  const [search, setSearch] = useState("")
  const [repository, setRepository] = useState("")
  const client = useQueryClient()
  const catalog = useQuery({ queryKey: skillsKey(root, kind), queryFn: () => window.zyvro.agent.skills(kind), enabled: root !== null })
  const install = useMutation({
    mutationFn: (url: string) => window.zyvro.agent.downloadPack(url),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["agent", "skills"] })
    },
  })
  const toggle = (key: "disabledSkills" | "enabledPacks", id: string, on: boolean) => {
    const a = getSettings().agent
    updateSettings({ agent: { ...a, [key]: (key === "enabledPacks" ? on : !on) ? [...new Set([...a[key], id])] : a[key].filter((v) => v !== id) } })
  }
  const requestSetup = (pack?: SkillPack) => {
    const prompt = pack
      ? `Prepare the skill pack ${pack.repository}, downloaded at ${JSON.stringify(pack.path)}, for ${HARNESS_INFO[kind].name} in Zyvro Studio. Inspect its README and setup requirements first, then install the required dependencies and configure it for this agent. For gstack, use its documented setup for this host. Preserve my existing configuration and report what is ready or still missing. Do not run a paid workflow to test it.`
      : "Help me find and install a skill pack for: "
    useWorkspace.getState().setPanel("agent", true)
    handTo("agent", prompt)
  }
  const visible = (catalog.data?.skills ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.pack ?? ""}`.toLowerCase().includes(search.toLowerCase()))
  const button = "rounded-md border border-white/10 px-3 py-2 text-xs hover:bg-white/5 disabled:opacity-40"
  return <div className="space-y-5">
    <p className="text-xs leading-relaxed text-muted-foreground">Enable Skills in a conversation to let the agent choose from this catalog, then read only the instructions it needs. These switches control Zyvro's catalog; skills loaded independently by your CLI keep their own settings.</p>
    {!pluginOn(settings.agent, "skills") && <p className="rounded-md bg-amber-400/10 p-3 text-xs text-amber-200">The Advanced skills plugin is off in Settings › Plugins. You can still manage the catalog here.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Skills for agent" value={kind} onChange={(e) => setKind(e.target.value as AgentKind)} className="rounded-md border border-white/10 bg-background p-2 text-xs">{AGENT_KINDS.map((k) => <option key={k} value={k}>{HARNESS_INFO[k].name}</option>)}</select>
      <button className={button} disabled={!root || catalog.isFetching} onClick={() => void catalog.refetch()}><RefreshCw className="mr-1 inline h-3 w-3" />Refresh</button>
    </div>
    <div className="rounded-xl border border-violet-400/20 bg-violet-400/[0.04] p-4">
      <p className="text-sm font-medium">Add a skill pack</p>
      <p className="mb-3 mt-1 text-xs leading-relaxed text-muted-foreground">Downloads instructions from a public GitHub repository. Setup scripts are not run by downloading. Packs with tools, including gstack, may need preparation for your agent.</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={install.isPending} onClick={() => install.mutate("https://github.com/garrytan/gstack")}><Download className="mr-1 inline h-3 w-3" />Download gstack</button>
        <button className={button} onClick={() => requestSetup()}>Ask agent for a pack…</button>
      </div>
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); install.mutate(repository) }}>
        <input aria-label="Skill pack GitHub repository" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="https://github.com/owner/repository" className="min-w-0 flex-1 basis-56 rounded-md border border-white/10 bg-background px-3 py-2 text-xs" />
        <button className={button} disabled={install.isPending || !repository.trim()}>Download pack</button>
      </form>
      {install.isPending && <p role="status" className="mt-3 text-xs">Downloading the repository…</p>}
      {install.error && <p role="alert" className="mt-3 break-words text-xs text-red-300">{install.error.message}</p>}
      {install.isSuccess && <p role="status" className="mt-3 text-xs text-emerald-300">Pack downloaded. Review its skills below, prepare any required tools, then enable it.</p>}
    </div>
    {catalog.data?.packs.map((pack) => <div key={pack.id} className="rounded-lg border border-white/10 px-4 pb-3">
      <SettingRow title={pack.repository.replace("https://github.com/", "")} hint={`Downloaded revision ${pack.revision.slice(0, 8)} · ${(catalog.data?.skills ?? []).filter((s) => s.pack === pack.id).length} skills`}>
        <Toggle label={`Enable pack ${pack.id}`} checked={settings.agent.enabledPacks.includes(pack.id)} onChange={(on) => toggle("enabledPacks", pack.id, on)} />
      </SettingRow>
      <button className={`${button} mt-3`} onClick={() => requestSetup(pack)}>Ask agent to prepare this pack…</button>
      <p className="mt-2 text-[11px] text-muted-foreground">Opens a draft in chat. Review it and send when ready.</p>
    </div>)}
    <input aria-label="Search skills" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search installed skills…" className="w-full rounded-md border border-white/10 bg-background px-3 py-2 text-sm" />
    {catalog.isLoading && <p role="status" className="text-xs text-muted-foreground">Reading installed skills…</p>}
    {catalog.error && <p role="alert" className="text-xs text-red-300">{catalog.error.message}</p>}
    {!root && <p className="text-xs text-muted-foreground">Waiting for the local workspace…</p>}
    {catalog.data?.warnings.map((warning) => <p key={warning} className="break-words text-xs text-amber-200">{warning}</p>)}
    {catalog.data && visible.length === 0 && <p className="text-xs text-muted-foreground">{search ? "No matching skills." : "No skills found for this agent. Download a pack or install skills in one of the folders below."}</p>}
    <div>{visible.map((skill) => <SettingRow key={skill.id} title={skill.name} hint={skill.description}>
      <div className="flex items-center gap-3"><span title={skill.path} className="text-[10px] text-muted-foreground">{skill.source}</span><Toggle label={`Enable skill ${skill.name}`} checked={skillEnabled(skill, settings.agent)} disabled={!!skill.pack && !settings.agent.enabledPacks.includes(skill.pack)} onChange={(on) => toggle("disabledSkills", skill.id, on)} /></div>
    </SettingRow>)}</div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Skill folders</summary>{catalog.data?.roots.map((folder) => <p key={folder} className="mt-2 break-all font-mono text-[11px]">{folder}</p>)}</details>
  </div>
}
