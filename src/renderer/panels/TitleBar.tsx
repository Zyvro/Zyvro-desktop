import { Code2, FolderOpen, PanelBottom, PanelLeft, PanelRight, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace, type Mode } from "~/state/workspace"
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

// The two modes, as a segmented control rather than a toggle, because a toggle
// only tells you what it is not currently doing. Both names are always on
// screen, and the one you are in is the one lit.
function ModeSwitch() {
  const mode = useWorkspace((s) => s.mode)
  const setMode = useWorkspace((s) => s.setMode)

  const options: { value: Mode; label: string; icon: typeof Code2; title: string }[] = [
    {
      value: "ai",
      label: "AI",
      icon: Sparkles,
      title: "The agent takes the middle. No shell, nothing open — until you open a file, and then it moves to the right.",
    },
    { value: "dev", label: "Dev", icon: Code2, title: "Editor, shell underneath, agent beside." },
  ]

  return (
    <div className="zy-nodrag flex rounded-md border border-white/[0.08] bg-white/[0.02] p-0.5">
      {options.map(({ value, label, icon: Icon, title }) => (
        <button
          key={value}
          title={title}
          onClick={() => setMode(value)}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded px-2 text-[12px]",
            mode === value ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:bg-white/[0.05]"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}

export function TitleBar() {
  const project = useWorkspace((s) => s.project)
  const panels = useWorkspace((s) => s.panels)
  const mode = useWorkspace((s) => s.mode)
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

      <ModeSwitch />

      <ToggleButton
        active={panels.explorer || panels.git}
        title="Toggle sidebar"
        onClick={() => togglePanel("explorer")}
      >
        <PanelLeft className="h-4 w-4" />
      </ToggleButton>
      {/* The shell and the agent are Dev's to arrange. In AI mode the layout is
          the mode, and a button that let you take the agent away would leave a
          window with nothing in the middle. */}
      {mode === "dev" && (
        <>
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
        </>
      )}
    </header>
  )
}
