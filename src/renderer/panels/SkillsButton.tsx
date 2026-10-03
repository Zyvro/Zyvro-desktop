import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { BookOpen, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { useSettingsPage } from "~/state/settingsPage"
import { skillEnabled, type AgentSettings } from "../../shared/skills"
import type { AgentKind } from "../../shared/harness"
import { skillsKey } from "./SettingsSkills"

export function SkillsButton({ kind, active, settings, disabled, onChange }: {
  kind: AgentKind; active: boolean; settings: AgentSettings; disabled: boolean; onChange: (active: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useWorkspace((s) => s.root)
  const catalog = useQuery({ queryKey: skillsKey(root, kind), queryFn: () => window.zyvro.agent.skills(kind), enabled: !!root && (open || active) })
  const count = catalog.data?.skills.filter((s) => skillEnabled(s, settings)).length
  const manage = () => {
    useSettingsPage.getState().selectSkills(kind)
    useWorkspace.getState().openSettings()
  }
  return <div className={cn("flex shrink-0 items-center rounded border", active ? "border-violet-400/30 bg-violet-400/10 text-violet-300" : "border-transparent text-muted-foreground")}>
    <button type="button" aria-label="Advanced skills" aria-pressed={active} disabled={disabled} onClick={() => onChange(!active)} title={active ? "Automatic skill selection is on for this conversation" : "Let the agent choose relevant skills for your request"} className="flex items-center gap-1 rounded-l px-1.5 py-1 text-[11px] hover:bg-white/5 disabled:opacity-40">
      <BookOpen className="h-3.5 w-3.5" /><span>Skills</span>{active && <span className="text-[10px]">{count ?? "…"}</span>}
    </button>
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger aria-label="Manage advanced skills" className="rounded-r px-1 py-1.5 hover:bg-white/5"><ChevronDown className="h-3 w-3" /></Menu.Trigger>
      <Menu.Portal><Menu.Content align="start" side="top" sideOffset={6} className="panel z-50 w-72 p-2">
        <p className="px-2 py-1 text-xs font-medium">Advanced skills</p>
        <p className="px-2 pb-2 text-[11px] leading-relaxed text-muted-foreground">When on, the agent receives the enabled skill catalog with your next prompt and chooses what to read.</p>
        <p role="status" className="px-2 pb-2 text-[11px] text-muted-foreground">{catalog.error ? "Could not load the catalog. Open settings to retry." : count === undefined ? "Reading the catalog…" : `${count} enabled skills for ${kind}`}</p>
        <Menu.Item onSelect={manage} className="cursor-default rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-white/10">Manage installed skills…</Menu.Item>
        <Menu.Item onSelect={manage} className="cursor-default rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-white/10">Get gstack or another pack…</Menu.Item>
      </Menu.Content></Menu.Portal>
    </Menu.Root>
  </div>
}
