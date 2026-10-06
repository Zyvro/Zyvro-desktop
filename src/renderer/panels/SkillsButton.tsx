import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { BookOpen, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { useSettingsPage } from "~/state/settingsPage"
import { skillEnabled, type AgentSettings } from "../../shared/skills"
import type { AgentKind } from "../../shared/harness"
import { skillsKey } from "./SettingsSkills"
import { RAIL_BUTTON, RAIL_MENU } from "./railButton"

// Les skills avancés, dans la barre verticale : une icône, violette quand le
// choix automatique est allumé pour cette conversation. Le menu l'allume,
// l'éteint, et mène au catalogue.
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
  return <Menu.Root open={open} onOpenChange={setOpen}>
    <Menu.Trigger
      aria-label="Advanced skills"
      aria-pressed={active}
      title={active ? `Advanced skills: on for this conversation${count !== undefined ? ` (${count} enabled)` : ""}` : "Advanced skills: off — let the agent choose relevant skills for your request"}
      className={cn(RAIL_BUTTON, active ? "bg-violet-400/10 text-violet-300" : "text-muted-foreground hover:text-foreground")}
    >
      <BookOpen className="h-3.5 w-3.5" />
    </Menu.Trigger>
    <Menu.Portal><Menu.Content {...RAIL_MENU} className="panel z-50 w-72 p-2">
      <p className="px-2 py-1 text-xs font-medium">Advanced skills</p>
      <p className="px-2 pb-2 text-[11px] leading-relaxed text-muted-foreground">When on, the agent receives the enabled skill catalog with your next prompt and chooses what to read.</p>
      <p role="status" className="px-2 pb-2 text-[11px] text-muted-foreground">{catalog.error ? "Could not load the catalog. Open settings to retry." : count === undefined ? "Reading the catalog…" : `${count} enabled skills for ${kind}`}</p>
      <Menu.Item
        disabled={disabled}
        onSelect={() => onChange(!active)}
        className="flex cursor-default items-center gap-2 rounded px-2 py-2 text-xs outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/10"
      >
        <Check className={cn("h-3 w-3", active ? "opacity-100" : "opacity-0")} />
        Choose skills automatically in this conversation
      </Menu.Item>
      <Menu.Separator className="my-1 h-px bg-white/[0.08]" />
      <Menu.Item onSelect={manage} className="cursor-default rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-white/10">Manage installed skills…</Menu.Item>
      <Menu.Item onSelect={manage} className="cursor-default rounded px-2 py-2 text-xs outline-none data-[highlighted]:bg-white/10">Get gstack or another pack…</Menu.Item>
    </Menu.Content></Menu.Portal>
  </Menu.Root>
}
