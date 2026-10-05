import { useQuery } from "@tanstack/react-query"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { ImagePlus, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { queryClient } from "~/lib/queryClient"
import { generatedIcon } from "../../shared/projectIcon"

// L'icône d'un projet, et le projet vers lequel part le prompt.
//
// Avec plusieurs projets ouverts dans la fenêtre, la boîte de l'agent ne disait
// pas où irait ce qu'on y tape : le projet au premier plan, qu'on avait peut-être
// changé sans y penser. L'icône le dit d'un coup d'œil — la même dans la barre
// des projets et sous la boîte. Générée par défaut (deux lettres sur une
// couleur propre au dossier), elle se remplace par une image choisie, rangée
// dans le projet (`.zyvro/icon.png`).

const key = (project: string) => ["project-icon", project] as const

let listening = false
function listen(): void {
  if (listening || typeof window === "undefined" || !window.zyvro?.project) return
  listening = true
  // Changée ici ou dans une autre fenêtre : toutes les icônes de ce projet suivent.
  window.zyvro.project.onIconChanged(({ project, icon }) => queryClient.setQueryData(key(project), icon))
}

export function useProjectIcon(project: string | null): string | null {
  listen()
  const { data } = useQuery({
    queryKey: key(project ?? ""),
    queryFn: () => window.zyvro.project.icon(project as string),
    enabled: project !== null,
    staleTime: Infinity,
    // Un projet fermé entre-temps fait refuser la question : pas d'icône
    // choisie, on montre la générée.
    retry: false,
  })
  return data ?? null
}

export function ProjectIcon({ project, name, size = 16, className }: { project: string; name: string; size?: number; className?: string }) {
  const custom = useProjectIcon(project)
  const radius = Math.max(3, Math.round(size / 4.5))
  if (custom) {
    return (
      <img
        src={custom}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 object-cover", className)}
        style={{ width: size, height: size, borderRadius: radius }}
        draggable={false}
      />
    )
  }
  const icon = generatedIcon(name, project)
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none", className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: icon.background,
        color: icon.foreground,
        fontSize: Math.max(7, Math.round(size * (icon.letters.length > 1 ? 0.42 : 0.55))),
        letterSpacing: "-0.02em",
      }}
    >
      {icon.letters}
    </span>
  )
}

/**
 * Le projet de la boîte de l'agent : son icône et son nom, juste sous ce qu'on
 * tape. Un clic propose de changer l'icône ou de revenir à la générée.
 */
export function PromptProject({ project, name }: { project: string; name: string }) {
  const custom = useProjectIcon(project)
  return (
    <Menu.Root>
      <Menu.Trigger
        title={`Prompts go to ${project}`}
        className="mb-[1px] flex min-w-0 max-w-[11rem] shrink items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-muted-foreground outline-none hover:bg-white/[0.08] hover:text-foreground data-[state=open]:bg-white/[0.08]"
      >
        <ProjectIcon project={project} name={name} size={14} />
        <span className="truncate">{name}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="panel z-50 w-64 p-1" align="start" side="top" sideOffset={6} collisionPadding={8}>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <ProjectIcon project={project} name={name} size={28} />
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-foreground">{name}</div>
              <div className="truncate text-[11px] text-muted-foreground" title={project}>
                {project}
              </div>
            </div>
          </div>
          <Menu.Separator className="my-1 h-px bg-white/[0.06]" />
          <Menu.Item
            onSelect={() => void window.zyvro.project.chooseIcon(project).catch(() => null)}
            className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-white/[0.06]"
          >
            <ImagePlus className="h-3.5 w-3.5" />
            {custom ? "Change the icon…" : "Choose an icon…"}
          </Menu.Item>
          {custom && (
            <Menu.Item
              onSelect={() => void window.zyvro.project.clearIcon(project).catch(() => false)}
              className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-white/[0.06]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Use the generated icon
            </Menu.Item>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
