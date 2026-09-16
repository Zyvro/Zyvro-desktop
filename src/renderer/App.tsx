import { useState } from "react"
import { Boxes, FolderTree, Settings2, Store } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { useCurrentProject, useNodeCatalogue } from "~/lib/project"
import { TitleBar } from "~/panels/TitleBar"
import { Explorer } from "~/panels/Explorer"
import { WorkflowList } from "~/panels/WorkflowList"
import { EditorArea } from "~/panels/EditorArea"
import { TerminalPanel } from "~/panels/TerminalPanel"
import { AgentPanel } from "~/panels/AgentPanel"
import { StatusBar } from "~/panels/StatusBar"
import { Splitter } from "~/panels/Splitter"
import { NamePrompt } from "~/panels/NamePrompt"
// Imported for its side effect: the menu listeners register once, at import
// time, which is how this app subscribes to anything without a useEffect.
import "~/lib/menuBridge"

const LIMITS = { sidebar: [180, 520], agent: [280, 720], terminal: [120, 640] } as const

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value))
}

function ActivityBar() {
  const panels = useWorkspace((s) => s.panels)
  const setPanel = useWorkspace((s) => s.setPanel)
  const openProviders = useWorkspace((s) => s.openProviders)
  const openStore = useWorkspace((s) => s.openStore)
  const activeTabId = useWorkspace((s) => s.activeTabId)

  const items = [
    {
      icon: FolderTree,
      label: "Explorer",
      active: panels.explorer,
      onClick: () => setPanel("explorer", !panels.explorer),
    },
    {
      icon: Store,
      label: "Store",
      active: activeTabId === "store",
      onClick: openStore,
    },
    {
      icon: Boxes,
      label: "Providers",
      active: activeTabId === "providers",
      onClick: openProviders,
    },
  ]

  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-white/[0.06] bg-background py-2">
      {items.map(({ icon: Icon, label, active, onClick }) => (
        <button
          key={label}
          title={label}
          onClick={onClick}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg",
            active ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:bg-white/[0.06]"
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </button>
      ))}
      <div className="flex-1" />
      <button
        title="Providers and keys"
        onClick={openProviders}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.06]"
      >
        <Settings2 className="h-[18px] w-[18px]" />
      </button>
    </nav>
  )
}

export default function App() {
  // The query runs for its adoption side effect as much as its data: it is what
  // reattaches the shared API client to the daemon after a renderer reload.
  useCurrentProject()
  // Runs for its side effect as much as its data: it is what tells the shared
  // node registry which Lua packs this project has installed.
  useNodeCatalogue()

  const panels = useWorkspace((s) => s.panels)
  const [sidebar, setSidebar] = useState(260)
  const [agent, setAgent] = useState(360)
  const [terminal, setTerminal] = useState(220)

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <ActivityBar />

        {panels.explorer && (
          <>
            <aside
              className="flex min-h-0 shrink-0 flex-col border-r border-white/[0.06] bg-background"
              style={{ width: sidebar }}
            >
              <Explorer />
              <WorkflowList />
            </aside>
            <Splitter
              orientation="vertical"
              onResize={(delta) => setSidebar((w) => clamp(w + delta, LIMITS.sidebar))}
            />
          </>
        )}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EditorArea />
          {panels.terminal && (
            <>
              <Splitter
                orientation="horizontal"
                onResize={(delta) => setTerminal((h) => clamp(h - delta, LIMITS.terminal))}
              />
              <div className="shrink-0" style={{ height: terminal }}>
                <TerminalPanel />
              </div>
            </>
          )}
        </main>

        {panels.agent && (
          <>
            <Splitter
              orientation="vertical"
              onResize={(delta) => setAgent((w) => clamp(w - delta, LIMITS.agent))}
            />
            <aside
              className="flex min-h-0 shrink-0 flex-col border-l border-white/[0.06] bg-background"
              style={{ width: agent }}
            >
              <AgentPanel />
            </aside>
          </>
        )}
      </div>

      <StatusBar />
      <NamePrompt />
    </div>
  )
}
