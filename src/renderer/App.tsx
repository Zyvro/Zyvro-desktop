import { useState } from "react"
import "~/lib/chatTheme"
import { Boxes, FolderTree, GitBranch, Search, Settings2, Store } from "lucide-react"
import { cn } from "@/lib/utils"
import { sidebarView, useWorkspace, type Mode, type PanelKey } from "~/state/workspace"
import { useCurrentProject, useNodeCatalogue } from "~/lib/project"
import { TitleBar } from "~/panels/TitleBar"
import { Explorer } from "~/panels/Explorer"
import { GitPanel } from "~/panels/GitPanel"
import { WorkflowList } from "~/panels/WorkflowList"
import { BrowserList } from "~/panels/BrowserList"
import { PersistentList } from "~/panels/PersistentList"
import { OutlineList } from "~/panels/OutlineList"
import { TimelineList } from "~/panels/TimelineList"
import { SearchPanel } from "~/panels/SearchPanel"
import { EditorArea } from "~/panels/EditorArea"
import { TerminalPanel } from "~/panels/TerminalPanel"
import { AgentPanel } from "~/panels/AgentPanel"
import { ShotOverlay } from "~/panels/ShotPicker"
import { ZoneHover } from "~/panels/ZoneHover"
import { StatusBar } from "~/panels/StatusBar"
import { Splitter } from "~/panels/Splitter"
import { NamePrompt } from "~/panels/NamePrompt"
import { QuickOpen } from "~/panels/QuickOpen"
import { UpdateDialog } from "~/panels/UpdateDialog"
// La vérification automatique des mises à jour s'installe à l'import.
import "~/state/update"
// Et les problèmes des fichiers ouverts, suivis dès le départ.
import "~/state/problems"
// Imported for its side effect: the menu listeners register once, at import
// time, which is how this app subscribes to anything without a useEffect.
import "~/lib/menuBridge"
import "~/lib/projectIndex"
// Pareil pour les dépôts sur la fenêtre : un dossier lâché s'ouvre en projet.
import "~/lib/windowDrop"

// Les limites des séparateurs. Le terminal n'a plus de plafond fixe : un
// panneau qu'on ne peut tirer qu'à 640 px reste bloqué à ~70 % d'un grand
// écran. Son maximum suit la fenêtre — toute la hauteur, moins un filet pour
// l'éditeur et les barres.
const LIMITS = { sidebar: [180, 520], agent: [280, 720], terminal: [80, Number.POSITIVE_INFINITY] } as const

function terminalMax(): number {
  // 160 px : barre de titre + status + un filet d'éditeur. Le reste est au
  // terminal, et c'est ce qu'on veut quand on le tire vers le haut.
  return Math.max(200, window.innerHeight - 160)
}

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value))
}

function ActivityBar() {
  const panels = useWorkspace((s) => s.panels)
  const setPanel = useWorkspace((s) => s.setPanel)
  const openProviders = useWorkspace((s) => s.openProviders)
  const openStore = useWorkspace((s) => s.openStore)
  const openSettings = useWorkspace((s) => s.openSettings)
  const activeTabId = useWorkspace((s) => s.activeTabId)

  const items = [
    {
      icon: FolderTree,
      label: "Explorer",
      active: panels.explorer,
      onClick: () => setPanel("explorer", !panels.explorer),
    },
    {
      icon: Search,
      label: "Search",
      active: panels.search,
      onClick: () => setPanel("search", !panels.search),
    },
    {
      icon: GitBranch,
      label: "Source Control",
      active: panels.git,
      onClick: () => setPanel("git", !panels.git),
    },
    {
      icon: Store,
      label: "Store",
      active: activeTabId === "store",
      onClick: openStore,
    },
  ]

  // En bas, ce qui règle l'application plutôt que ce qu'on y fait : les
  // fournisseurs, puis les réglages — comme VS Code garde Comptes et Gérer au
  // pied de sa barre. Le bouton du bas ouvrait Providers une seconde fois ; il
  // ouvre maintenant Settings.
  const bottom = [
    {
      icon: Boxes,
      label: "Providers",
      active: activeTabId === "providers",
      onClick: openProviders,
    },
    {
      icon: Settings2,
      label: "Settings",
      active: activeTabId === "settings",
      onClick: openSettings,
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
      {bottom.map(({ icon: Icon, label, active, onClick }) => (
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
    </nav>
  )
}

// The layout each mode asks for, worked out in one place rather than by three
// components each checking the mode for themselves.
//
// The rule that matters is the last one: in AI mode the agent is the work
// surface until something is open, and opening a file is what makes the person
// a reader rather than an asker. So the agent moves aside then — not because a
// layout button was pressed, but because the work changed.
function layoutFor(mode: Mode, panels: Record<PanelKey, boolean>, hasTabs: boolean) {
  if (mode === "dev") {
    return { editor: true, terminal: panels.terminal, agentBeside: panels.agent, agentCentre: false }
  }
  return {
    editor: hasTabs,
    // No shell in AI mode. It is the difference between the two, not a panel
    // that happens to be closed.
    terminal: false,
    agentBeside: hasTabs,
    agentCentre: !hasTabs,
  }
}

export default function App() {
  // The query runs for its adoption side effect as much as its data: it is what
  // reattaches the shared API client to the daemon after a renderer reload.
  useCurrentProject()
  // Runs for its side effect as much as its data: it is what tells the shared
  // node registry which Lua packs this project has installed.
  useNodeCatalogue()

  const panels = useWorkspace((s) => s.panels)
  const mode = useWorkspace((s) => s.mode)
  const hasTabs = useWorkspace((s) => s.tabs.length > 0)
  const view = sidebarView(panels)
  const layout = layoutFor(mode, panels, hasTabs)
  const [sidebar, setSidebar] = useState(260)
  const [agent, setAgent] = useState(360)
  const [terminal, setTerminal] = useState(220)

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBar />

      {/* La fenêtre entière est une zone aussi : c'est la plus grande, donc la
          dernière visée, et c'est elle qu'on veut quand on montre l'atelier
          plutôt qu'un panneau. */}
      <div data-shot-zone="Window" className="flex min-h-0 flex-1">
        <ActivityBar />

        {view && (
          <>
            {/* Les zones que le sélecteur de capture propose. L'attribut vit
                sur le panneau lui-même : celui qui disparaît disparaît du
                choix, sans que rien d'autre ait à le savoir. */}
            <aside
              data-shot-zone={view === "explorer" ? "Explorer" : view === "search" ? "Search" : "Source control"}
              className="flex min-h-0 shrink-0 flex-col border-r border-white/[0.06] bg-background"
              style={{ width: sidebar }}
            >
              {view === "search" ? (
                <SearchPanel />
              ) : view === "explorer" ? (
                <>
                  <Explorer />
                  {/* Au-dessus des workflows : c'est ce qu'on ouvre et ferme le
                      plus souvent dans une session de mise au point, et ce
                      qu'un agent est en train de piloter pendant qu'on lit. */}
                  <BrowserList />
                  {/* Entre les deux, à la place que Jeremy a demandée : ce sont
                      des choses qu'on ouvre et ferme au rythme d'une vue de
                      navigateur, et qui appartiennent au projet comme un
                      workflow. La section ne se dessine pas là où ni `tmux` ni
                      `screen` n'existent. */}
                  <PersistentList />
                  <WorkflowList />
                  {/* Tout en bas, repliée par défaut, comme dans VS Code. */}
                  <OutlineList />
                  <TimelineList />
                </>
              ) : (
                <GitPanel />
              )}
            </aside>
            <Splitter
              orientation="vertical"
              onResize={(delta) => setSidebar((w) => clamp(w + delta, LIMITS.sidebar))}
            />
          </>
        )}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* La zone de l'éditeur (ou de l'agent au centre) s'arrête au-dessus
              du terminal. Posée sur tout le <main>, elle l'englobait : viser
              le code allumait un cadre autour du panneau shell aussi, et une
              capture « Editor » emportait le terminal avec elle. */}
          <div data-shot-zone={layout.agentCentre ? "Agent" : "Editor"} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {layout.agentCentre ? <AgentPanel /> : <EditorArea />}
          </div>
          {layout.terminal && (
            <>
              <Splitter
                orientation="horizontal"
                onResize={(delta) => setTerminal((h) => clamp(h - delta, [LIMITS.terminal[0], terminalMax()]))}
              />
              <div data-shot-zone="Terminal" className="shrink-0" style={{ height: terminal }}>
                <TerminalPanel />
              </div>
            </>
          )}
        </main>

        {layout.agentBeside && (
          <>
            <Splitter
              orientation="vertical"
              onResize={(delta) => setAgent((w) => clamp(w - delta, LIMITS.agent))}
            />
            <aside
              data-shot-zone="Agent"
              className="flex min-h-0 shrink-0 flex-col border-l border-white/[0.06] bg-background"
              style={{ width: agent }}
            >
              {/* La bordure est ici et non dans AgentPanel : au centre, en mode
                  IA, le panneau n'a pas de voisin à gauche à séparer — l'aside
                  du dossier trace déjà ce trait, et deux traits font un double
                  filet. */}
              <AgentPanel />
            </aside>
          </>
        )}
      </div>

      <StatusBar />
      <ZoneHover />
      <ShotOverlay />
      <NamePrompt />
      <QuickOpen />
      <UpdateDialog />
    </div>
  )
}
