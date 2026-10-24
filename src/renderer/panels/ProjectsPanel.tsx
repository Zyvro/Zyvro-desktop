import { useState } from "react"
import { ChevronDown, ChevronRight, FolderOpen, Plus, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { ProjectIcon } from "~/panels/ProjectIcon"
import { closeProjectAt, forgetRecents, newZyvro, openProject, switchProject, useRecents } from "~/lib/project"

// Les projets en panneau, à gauche ou à droite de la fenêtre — l'autre façon de
// les montrer que les onglets de la barre de titre (state/layoutPrefs).
//
// Des onglets se serrent vite : passé cinq projets, leurs noms se coupent et on
// cherche le bon à l'œil. En colonne, chacun a sa ligne : son nom entier, le
// dossier qui le contient (deux « api » ne se confondent plus), et les projets
// récents juste dessous, qu'un clic rouvre. Un filtre apparaît quand la liste
// s'allonge.

// Le dossier qui contient le projet, en deux segments : assez pour distinguer
// ~/work/api de ~/perso/api sans écrire tout le chemin.
export function parentHint(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean)
  parts.pop()
  return parts.slice(-2).join("/")
}

function Row({
  path,
  name,
  active,
  onOpen,
  onClose,
}: {
  path: string
  name: string
  active: boolean
  onOpen: () => void
  onClose?: () => void
}) {
  return (
    <div
      className={cn(
        "group relative mx-1 flex items-center gap-2 rounded-md py-1 pl-2 pr-1",
        active ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground/90"
      )}
      // Clic du milieu : fermer, comme un onglet.
      onAuxClick={(event) => {
        if (event.button === 1 && onClose) {
          event.preventDefault()
          onClose()
        }
      }}
    >
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />}
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen} title={path}>
        <ProjectIcon project={path} name={name} size={18} />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[13px]", active && "font-medium")}>{name}</span>
          <span className="block truncate text-[11px] text-muted-foreground/80">{parentHint(path) || path}</span>
        </span>
      </button>
      {onClose && (
        <button
          type="button"
          className={cn(
            "shrink-0 rounded p-0.5 transition-opacity hover:bg-white/[0.08]",
            active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
          )}
          title={`Close ${name}`}
          onClick={onClose}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

export function ProjectsPanel({ side }: { side: "left" | "right" }) {
  const projects = useWorkspace((s) => s.projects)
  const current = useWorkspace((s) => s.project?.project ?? null)
  const recents = useRecents()
  const [filtre, setFiltre] = useState("")
  const [recentsOuverts, setRecentsOuverts] = useState(true)

  const ouverts = new Set(projects.map((p) => p.project))
  const anciens = (recents.data ?? []).filter((r) => !ouverts.has(r.path)).slice(0, 20)
  const avecFiltre = projects.length + anciens.length > 8
  const q = filtre.trim().toLowerCase()
  const garde = (name: string, path: string): boolean => !q || name.toLowerCase().includes(q) || path.toLowerCase().includes(q)

  return (
    <nav
      data-shot-zone="Projects"
      className={cn(
        "flex h-full min-h-0 flex-col bg-background",
        side === "left" ? "border-r border-white/[0.06]" : "border-l border-white/[0.06]"
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-3">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Projects</span>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          title="Open a project folder"
          onClick={() => void openProject(null)}
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          title="New Zyvro — the welcome screen, without closing your projects"
          onClick={() => void newZyvro()}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {avecFiltre && (
        <label className="mx-2 mb-1 flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            value={filtre}
            onChange={(event) => setFiltre(event.target.value)}
            placeholder="Filter projects"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/70"
          />
        </label>
      )}

      <div className="zy-scroll min-h-0 flex-1 overflow-y-auto pb-2">
        {projects.length === 0 && (
          <button
            type="button"
            className="mx-2 mt-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground/90 hover:bg-white/[0.06]"
            onClick={() => void openProject(null)}
          >
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
            Open a project…
          </button>
        )}
        {projects
          .filter((p) => garde(p.name, p.project))
          .map((p) => (
            <Row
              key={p.project}
              path={p.project}
              name={p.name}
              active={current === p.project}
              onOpen={() => void switchProject(p.project)}
              onClose={() => void closeProjectAt(p.project)}
            />
          ))}
        {!current && projects.length > 0 && (
          <div className="mx-1 mt-0.5 flex items-center gap-2 rounded-md bg-white/[0.09] px-2 py-1.5 text-[13px] text-foreground">
            <Plus className="h-3.5 w-3.5 text-muted-foreground" /> New Zyvro
          </div>
        )}

        {anciens.length > 0 && (
          <div className="mt-3">
            <div className="group flex items-center px-2">
              <button
                type="button"
                className="flex flex-1 items-center gap-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                onClick={() => setRecentsOuverts((o) => !o)}
              >
                {recentsOuverts ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Recent
              </button>
              <button
                type="button"
                className="rounded px-1 text-[11px] text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                title="Forget the recent projects"
                onClick={() => void forgetRecents()}
              >
                Clear
              </button>
            </div>
            {recentsOuverts &&
              anciens
                .filter((r) => garde(r.name, r.path))
                .map((r) => (
                  <Row key={r.path} path={r.path} name={r.name} active={false} onOpen={() => void openProject(r.path)} />
                ))}
          </div>
        )}
      </div>
    </nav>
  )
}
