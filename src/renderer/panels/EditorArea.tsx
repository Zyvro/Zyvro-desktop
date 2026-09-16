import { useCallback } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace, type Tab } from "~/state/workspace"
import { CodeEditor } from "./CodeEditor"
import { GraphTab } from "./GraphTab"
import { DiffView } from "./DiffView"
import { GitOutput } from "./GitOutput"
import { Welcome } from "./Welcome"
import { ProvidersTab } from "./ProvidersTab"
import { StorePanel } from "./StorePanel"

// Every open tab stays mounted. A graph that unmounted when you glanced at a
// file would lose its viewport, its selection and any run in progress, so tabs
// are hidden rather than destroyed, and only the active one is visible.

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  const activateTab = useWorkspace((s) => s.activateTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const dirty = useWorkspace((s) => tab.id in s.drafts)

  // A callback ref rather than an effect, per DOCTRINE-SANS-USEEFFECT: the
  // identity changes with `active`, so React runs it exactly when this tab
  // becomes the active one. Opening a file when the bar is already full would
  // otherwise put its tab somewhere off to the right, out of sight.
  const reveal = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && active) el.scrollIntoView({ block: "nearest", inline: "nearest" })
    },
    [active]
  )

  return (
    <div
      ref={reveal}
      className={cn(
        "group flex h-9 max-w-[220px] shrink-0 items-center gap-2 border-r border-white/[0.06] pl-3 pr-2 text-[13px]",
        active
          ? "bg-background text-foreground"
          : "bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]"
      )}
    >
      <button className="min-w-0 flex-1 truncate text-left" onClick={() => activateTab(tab.id)}>
        {tab.title}
      </button>
      <button
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
        title={dirty ? "Close without saving" : "Close"}
        onClick={() => closeTab(tab.id)}
      >
        {dirty ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary group-hover:hidden" />
        ) : null}
        <X className={cn("h-3 w-3", dirty && "hidden group-hover:block")} />
      </button>
    </div>
  )
}

function TabBody({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "file":
      return <CodeEditor tabId={tab.id} path={tab.path} />
    case "graph":
      return <GraphTab workflowId={tab.workflowId} />
    case "diff":
      return <DiffView path={tab.path} staged={tab.staged} />
    case "gitOutput":
      return <GitOutput />
    case "providers":
      return <ProvidersTab />
    case "store":
      return <StorePanel />
    default:
      return <Welcome />
  }
}

export function EditorArea() {
  const tabs = useWorkspace((s) => s.tabs)
  const activeTabId = useWorkspace((s) => s.activeTabId)

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* overflow-y is pinned hidden on purpose. Setting overflow-x alone makes
          the browser compute overflow-y as auto, and then the horizontal
          scrollbar eats a few pixels inside a fixed height — so the row of tabs
          became a few pixels too tall for its own box and scrolled vertically,
          carrying the tabs out of view. */}
      <div className="zy-tabs flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-white/[0.06] bg-white/[0.015]">
        {tabs.map((tab) => (
          <TabButton key={tab.id} tab={tab} active={tab.id === activeTabId} />
        ))}
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <div key={tab.id} className="absolute inset-0" hidden={tab.id !== activeTabId}>
            <TabBody tab={tab} />
          </div>
        ))}
      </div>
    </section>
  )
}
