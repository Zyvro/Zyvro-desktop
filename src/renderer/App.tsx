import { useState, useSyncExternalStore } from "react"
import "~/lib/chatTheme"
import { Boxes, FolderTree, GitBranch, Search, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { sidebarView, useWorkspace, type Mode, type PanelKey } from "~/state/workspace"
import { useCurrentProject } from "~/lib/project"
import { TitleBar } from "~/panels/TitleBar"
import { Explorer } from "~/panels/Explorer"
import { GitPanel } from "~/panels/GitPanel"
import { BrowserList } from "~/panels/BrowserList"
import { AgentShellList } from "~/panels/AgentShellList"
import { OutlineList } from "~/panels/OutlineList"
import { TimelineList } from "~/panels/TimelineList"
import { SearchPanel } from "~/panels/SearchPanel"
import { EditorArea } from "~/panels/EditorArea"
import { TerminalPanel } from "~/panels/TerminalPanel"
import { ShellRail } from "~/panels/ShellRail"
import { shellDock, subscribeShellDock } from "~/state/shellDock"
import { layoutPrefs, setLayout, subscribeLayout, type Side } from "~/state/layoutPrefs"
import { ProjectsPanel } from "~/panels/ProjectsPanel"
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
// Le Shell se range à droite (largeur) ou en dessous (hauteur) ; ni l'un ni
// l'autre n'a de plafond fixe, il suit la fenêtre.
const LIMITS = { sidebar: [180, 520], shellWidth: [320, Number.POSITIVE_INFINITY], shellHeight: [80, Number.POSITIVE_INFINITY] } as const

function shellMaxHeight(): number {
  // 160 px : barre de titre + status + un filet d'éditeur. Le reste est au
  // Shell, et c'est ce qu'on veut quand on le tire vers le haut.
  return Math.max(200, window.innerHeight - 160)
}

function shellMaxWidth(): number {
  // Le Shell peut prendre presque toute la largeur : 260 px restent à la barre
  // latérale et au code.
  return Math.max(400, window.innerWidth - 260)
}

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value))
}

function ActivityBar({ side, style }: { side: Side; style?: React.CSSProperties }) {
  const panels = useWorkspace((s) => s.panels)
  const setPanel = useWorkspace((s) => s.setPanel)
  const openProviders = useWorkspace((s) => s.openProviders)
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
    <nav
      className={cn(
        "flex w-12 shrink-0 flex-col items-center gap-1 border-white/[0.06] bg-background py-2",
        side === "left" ? "border-r" : "border-l"
      )}
      style={style}
    >
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
// Dev is the code with the Shell beside or under it (the person's choice,
// `shellDock`). AI is the Shell alone: it takes the whole middle, because in
// that mode the work is asking, not reading. Opening a file is what says "now I
// want to read this myself", and that is the moment the Shell steps aside to
// its dock rather than the moment you go looking for a layout button.
function layoutFor(mode: Mode, panels: Record<PanelKey, boolean>, hasTabs: boolean) {
  if (mode === "dev") {
    return { shell: panels.terminal || panels.agent, centre: false }
  }
  return { shell: true, centre: !hasTabs }
}

export default function App() {
  // The query runs for its adoption side effect as much as its data: it is what
  // reattaches the shared API client to the daemon after a renderer reload.
  useCurrentProject()

  const panels = useWorkspace((s) => s.panels)
  const mode = useWorkspace((s) => s.mode)
  const hasTabs = useWorkspace((s) => s.tabs.length > 0)
  const view = sidebarView(panels)
  const layout = layoutFor(mode, panels, hasTabs)
  const [sidebar, setSidebar] = useState(260)
  const [shellW, setShellW] = useState(520)
  const [shellH, setShellH] = useState(260)
  const dock = useSyncExternalStore(subscribeShellDock, shellDock, () => "right" as const)
  const prefs = useSyncExternalStore(subscribeLayout, layoutPrefs, layoutPrefs)
  const side = prefs.sidebar
  // Chaque pièce garde sa place dans l'arbre et ne change que d'ORDRE (CSS
  // `order`) : déplacer un composant React le remonterait, et l'explorateur
  // perdrait ses dossiers dépliés, le Shell ses processus.
  //   projets à gauche | barre d'activité, fichiers | code + Shell | fichiers,
  //   barre d'activité | projets à droite | barre du Shell
  const order = {
    projects: prefs.projects === "left" ? 1 : 60,
    projectsSplit: prefs.projects === "left" ? 2 : 59,
    activity: side === "left" ? 10 : 53,
    sidebar: side === "left" ? 11 : 52,
    sidebarSplit: side === "left" ? 12 : 51,
    centre: 30,
    rail: 70,
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBar />

      {/* La fenêtre entière est une zone aussi : c'est la plus grande, donc la
          dernière visée, et c'est elle qu'on veut quand on montre l'atelier
          plutôt qu'un panneau. */}
      <div data-shot-zone="Window" className="flex min-h-0 flex-1">
        {prefs.projects !== "top" && (
          <>
            <div className="min-h-0 shrink-0" style={{ order: order.projects, width: prefs.projectsWidth }}>
              <ProjectsPanel side={prefs.projects} />
            </div>
            <div style={{ order: order.projectsSplit }} className="flex">
              <Splitter
                orientation="vertical"
                onResize={(delta) =>
                  setLayout({ projectsWidth: layoutPrefs().projectsWidth + (prefs.projects === "left" ? delta : -delta) })
                }
              />
            </div>
          </>
        )}

        <ActivityBar side={side} style={{ order: order.activity }} />

        {view && (
          <>
            {/* Les zones que le sélecteur de capture propose. L'attribut vit
                sur le panneau lui-même : celui qui disparaît disparaît du
                choix, sans que rien d'autre ait à le savoir. */}
            <aside
              data-shot-zone={view === "explorer" ? "Explorer" : view === "search" ? "Search" : "Source control"}
              className={cn(
                "flex min-h-0 shrink-0 flex-col border-white/[0.06] bg-background",
                side === "left" ? "border-r" : "border-l"
              )}
              style={{ width: sidebar, order: order.sidebar }}
            >
              {view === "search" ? (
                <SearchPanel />
              ) : view === "explorer" ? (
                <>
                  <Explorer />
                  {/* Ce qu'on ouvre et ferme le plus souvent dans une session de
                      mise au point, et ce qu'un agent est en train de piloter
                      pendant qu'on lit. */}
                  <BrowserList />
                  {/* Les agents lancés dans un shell, et de quoi les reprendre. */}
                  <AgentShellList />
                  {/* Tout en bas, repliée par défaut, comme dans VS Code. */}
                  <OutlineList />
                  <TimelineList />
                </>
              ) : (
                <GitPanel />
              )}
            </aside>
            <div style={{ order: order.sidebarSplit }} className="flex">
              <Splitter
                orientation="vertical"
                onResize={(delta) => setSidebar((w) => clamp(w + (side === "left" ? delta : -delta), LIMITS.sidebar))}
              />
            </div>
          </>
        )}

        {/* Le code et le Shell, dans un seul conteneur dont seule la DIRECTION
            change (à droite : en ligne, en dessous : en colonne). Le Shell ne
            change jamais de place dans l'arbre : un composant déplacé est
            remonté, et remonter le panneau tuerait les processus de ses
            onglets — un `claude` en plein travail, un serveur de dev.
            Masqué, jamais démonté, pour la même raison. */}
        <div
          className={cn("flex min-h-0 min-w-0 flex-1", dock === "right" ? "flex-row" : "flex-col")}
          style={{ order: order.centre }}
        >
          <main
            data-shot-zone={layout.centre ? undefined : "Editor"}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", layout.centre && "hidden")}
          >
            <EditorArea />
          </main>
          {layout.shell && !layout.centre && (
            <Splitter
              orientation={dock === "right" ? "vertical" : "horizontal"}
              onResize={(delta) =>
                dock === "right"
                  ? setShellW((w) => clamp(w - delta, [LIMITS.shellWidth[0], shellMaxWidth()]))
                  : setShellH((h) => clamp(h - delta, [LIMITS.shellHeight[0], shellMaxHeight()]))
              }
            />
          )}
          <section
            data-shot-zone={layout.shell ? "Shell" : undefined}
            className={cn(
              "min-h-0 min-w-0",
              !layout.shell && "hidden",
              layout.centre ? "flex-1" : "shrink-0"
            )}
            style={
              layout.centre ? undefined : dock === "right" ? { width: shellW } : { height: shellH }
            }
          >
            <TerminalPanel />
          </section>
        </div>

        {/* La barre latérale droite : plugins de l'agent et logo du projet. */}
        <div className="flex min-h-0" style={{ order: order.rail }}>
          <ShellRail />
        </div>
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
