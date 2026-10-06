import { useSyncExternalStore } from "react"
import { Code2, FolderOpen, PanelBottom, PanelLeft, PanelRight, Plus, Sparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace, type Mode } from "~/state/workspace"
import { ProjectIcon } from "~/panels/ProjectIcon"
import { closeProject, newZyvro, openProject, switchProject } from "~/lib/project"

// The native title bar is hidden so the window reads as an editor. That makes
// this strip responsible for two things the OS normally handles: giving the
// user somewhere to drag, and leaving room for the traffic lights on macOS.
//
// Les projets ouverts y sont des onglets : cliquer bascule, le + en ouvre un
// de plus dans la même fenêtre, et chaque projet garde ses onglets de fichiers,
// ses panneaux et ses shells — voir `state/workspace` (ProjectUi).

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

/**
 * Un onglet de projet : son nom, et une croix pour le fermer.
 *
 * Cliquer bascule vers ce projet — ses onglets de fichiers, ses panneaux, ses
 * shells reprennent où ils en étaient. La croix ferme CE projet (avec la
 * question Save pour ses fichiers modifiés) et laisse les autres.
 */
function ProjectChip({
  name,
  path,
  active,
}: {
  name: string
  path: string
  active: boolean
}) {
  return (
    <div
      className={cn(
        "zy-nodrag group flex h-7 max-w-[180px] items-center gap-1 rounded-md pl-2 pr-1 text-[13px]",
        active
          ? "bg-white/[0.09] text-foreground"
          : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground/90"
      )}
    >
      <button
        className="flex min-w-0 items-center gap-1.5 truncate"
        onClick={() => void switchProject(path)}
        title={path}
      >
        <ProjectIcon project={path} name={name} size={14} />
        <span className="truncate">{name}</span>
      </button>
      <button
        className={cn(
          "rounded p-0.5 transition-opacity hover:bg-white/[0.08]",
          active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
        )}
        title={`Close ${name}`}
        onClick={() => void closeProject()}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

// Le plein écran de la fenêtre, tenu hors de React : un abonnement au
// principal, pas un effet — ce dépôt n'en veut pas.
let plein = false
const abonnes = new Set<() => void>()
let ecoute = false
function subscribeFullScreen(listener: () => void): () => void {
  abonnes.add(listener)
  if (!ecoute && window.zyvro?.window) {
    ecoute = true
    const poser = (on: boolean) => {
      plein = on
      for (const l of abonnes) l()
    }
    window.zyvro.window.onFullScreen(poser)
    void window.zyvro.window.isFullScreen().then(poser).catch(() => {})
  }
  return () => {
    abonnes.delete(listener)
  }
}
function isFullScreen(): boolean {
  return plein
}

export function TitleBar() {
  const project = useWorkspace((s) => s.project)
  const projects = useWorkspace((s) => s.projects)
  const panels = useWorkspace((s) => s.panels)
  const mode = useWorkspace((s) => s.mode)
  const togglePanel = useWorkspace((s) => s.togglePanel)
  const isMac = window.zyvro.platform === "darwin"
  const fullScreen = useSyncExternalStore(subscribeFullScreen, isFullScreen, () => false)

  return (
    <header
      className={cn(
        "zy-drag flex h-11 shrink-0 items-center gap-1 border-b border-white/[0.06] bg-background pr-2",
        // La place des trois boutons de macOS, sauf en plein écran : ils n'y
        // sont plus, comme dans Chrome, et la barre reprend sa gauche.
        isMac && !fullScreen ? "pl-[86px]" : "pl-2"
      )}
    >
      {projects.length === 0 ? (
        <button
          className="zy-nodrag flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-foreground/90 hover:bg-white/[0.06]"
          onClick={() => void openProject(null)}
          title="Open a project folder"
        >
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="max-w-[240px] truncate">Open a project…</span>
        </button>
      ) : (
        <div className="zy-nodrag flex min-w-0 items-center gap-1 overflow-x-auto">
          {projects.map((p) => (
            <ProjectChip
              key={p.project}
              name={p.name}
              path={p.project}
              active={project?.project === p.project}
            />
          ))}
          {/* Le Zyvro neuf ouvert par le « + », tant qu'on y est : l'accueil,
              qui n'est aucun des projets ci-contre. */}
          {!project && (
            <span className="flex h-7 shrink-0 items-center rounded-md bg-white/[0.09] px-2.5 text-[13px] text-foreground">
              New Zyvro
            </span>
          )}
        </div>
      )}

      {/* Le + : un nouveau Zyvro dans cette fenêtre — l'écran d'accueil, d'où
          l'on crée, ouvre ou clone un projet. Pas un sélecteur de dossier
          d'emblée : demander « quel dossier ? » avant de montrer quoi que ce
          soit suppose qu'on sait déjà ce qu'on veut ouvrir. Les projets
          ouverts restent dans la barre. Caché tant qu'on est déjà sur ce
          Zyvro neuf : un second ne montrerait que le même accueil. */}
      {project && (
      <button
        className="zy-nodrag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        onClick={() => void newZyvro()}
        title="New Zyvro — open the welcome screen without closing your projects"
      >
        <Plus className="h-4 w-4" />
      </button>
      )}

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
