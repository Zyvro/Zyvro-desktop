import { FolderOpen, PanelBottom, PanelLeft, PanelRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { useOpenProject } from "~/lib/project"

// The native title bar is hidden so the window reads as an editor. That makes
// this strip responsible for two things the OS normally handles: giving the
// user somewhere to drag, and leaving room for the traffic lights on macOS.

function ToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={cn(
        "zy-nodrag flex h-7 w-7 items-center justify-center rounded-md",
        active ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:bg-white/[0.06]"
      )}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function TitleBar() {
  const project = useWorkspace((s) => s.project)
  const panels = useWorkspace((s) => s.panels)
  const togglePanel = useWorkspace((s) => s.togglePanel)
  const open = useOpenProject()
  const isMac = window.zyvro.platform === "darwin"

  return (
    <header
      className={cn(
        "zy-drag flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-background pr-2",
        isMac ? "pl-[86px]" : "pl-2"
      )}
    >
      <button
        className="zy-nodrag flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-foreground/90 hover:bg-white/[0.06]"
        onClick={() => open.mutate(null)}
        title="Open a project folder"
      >
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[240px] truncate">{project?.name ?? "Open a project…"}</span>
      </button>

      <div className="flex-1" />

      <ToggleButton
        active={panels.explorer}
        title="Toggle sidebar"
        onClick={() => togglePanel("explorer")}
      >
        <PanelLeft className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton
        active={panels.terminal}
        title="Toggle terminal"
        onClick={() => togglePanel("terminal")}
      >
        <PanelBottom className="h-4 w-4" />
      </ToggleButton>
      <ToggleButton active={panels.agent} title="Toggle agent" onClick={() => togglePanel("agent")}>
        <PanelRight className="h-4 w-4" />
      </ToggleButton>
    </header>
  )
}
