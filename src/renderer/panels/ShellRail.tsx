import { useSyncExternalStore } from "react"
import { Bot, Columns2, PanelBottom, PanelRight, Plus } from "lucide-react"
import { SHELL_PLUGINS } from "../../shared/plugins"
import { AgentRail, type AgentRailContext } from "~/plugins"
import { getLauncher, launcherSpec, openLauncher, setLauncher, subscribeLauncher } from "~/state/launcher"
import { askAgent } from "~/state/persistent"
import { requestTerminalSplit } from "~/state/terminalSplit"
import { shellDock, subscribeShellDock, toggleShellDock } from "~/state/shellDock"
import { logoPosition, setLogoPosition, subscribeLogoPosition } from "~/state/railLogo"
import { useWorkspace } from "~/state/workspace"
import { askOpenShell } from "~/state/shellRequests"
import { RAIL_BUTTON } from "./railButton"
import { RailProject } from "./ProjectIcon"

// La barre latérale droite de Shell + Agents.
//
// C'était la barre verticale du chat : ce qui gouverne l'agent sans être la
// conversation. Elle reste, avec les mêmes plugins (permission, skills, mémoire
// du projet, réécriture de la tâche, rapport de bug, plugins en paquets) mais
// ils parlent maintenant au lanceur au lieu d'une conversation : la permission
// et les skills qu'on y règle sont ceux du prochain agent lancé, et « mettre à
// jour la mémoire » ouvre un agent avec cette tâche.
//
// Le logo du projet y vit aussi, en bas ou en haut à la demande. Il dit où
// travaillent les agents qu'on lance — avec plusieurs projets ouverts, c'est la
// première chose à vérifier avant d'appuyer sur Entrée.

export function ShellRail(): JSX.Element {
  const launcher = useSyncExternalStore(subscribeLauncher, getLauncher)
  const position = useSyncExternalStore(subscribeLogoPosition, logoPosition)
  const project = useWorkspace((s) => s.project)
  const dock = useSyncExternalStore(subscribeShellDock, shellDock, () => "right" as const)
  const mode = useWorkspace((s) => s.mode)

  const ctx: AgentRailContext = {
    kind: launcher.kind,
    disabled: false,
    permission: launcher.permission,
    project: project?.project ?? null,
    thread: {
      id: "launcher",
      model: launcher.model,
      ranWith: null,
      context: null,
      busy: false,
      queued: 0,
      started: false,
      advancedSkills: launcher.skills,
    },
    draft: "",
    rewriting: false,
    commands: [],
    actions: {
      // Une demande qui ne vient pas de la boîte : un agent à elle, avec le
      // nom de la demande.
      runInThread: (title, prompt) => {
        useWorkspace.getState().setPanel("terminal", true)
        askAgent({ ...launcherSpec(prompt), name: title })
      },
      setAdvancedSkills: (skills) => setLauncher({ skills, profileId: null }),
      // `/compact` est une commande du harnais, dans son interface.
      compact: () => undefined,
      // Pas de zone de saisie ici : rien à réécrire.
      rewriteNow: () => undefined,
      snapshot: () => ({ surface: "shell-agents", launcher: { ...launcher, instructions: undefined } }),
      setPermission: (permission) => setLauncher({ permission, profileId: null }),
    },
  }

  const logo = project ? (
    <RailProject project={project.project} name={project.name} position={position} onMove={setLogoPosition} />
  ) : null

  return (
    <div
      className="flex w-7 shrink-0 flex-col items-center gap-0.5 border-l border-white/[0.06] py-1.5"
      data-agent-rail
      data-shell-rail
    >
      {position === "top" && logo}
      {position === "top" && logo && <span className="my-1 h-px w-4 bg-white/[0.08]" aria-hidden />}

      <button
        type="button"
        className={RAIL_BUTTON}
        title="New shell"
        aria-label="New shell"
        onClick={() => askOpenShell()}
      >
        <Plus className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <button
        type="button"
        className={RAIL_BUTTON}
        title="Run an agent — pick its configuration and write the task"
        aria-label="Run an agent"
        onClick={openLauncher}
      >
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      <button
        type="button"
        className={RAIL_BUTTON}
        title="Split the terminal"
        aria-label="Split the terminal"
        onClick={() => {
          useWorkspace.getState().setPanel("terminal", true)
          requestTerminalSplit()
        }}
      >
        <Columns2 className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {/* Le Shell à droite du code, ou en dessous. En mode IA il prend toute la
          fenêtre tant qu'aucun fichier n'est ouvert : le choix ne sert alors
          qu'à la suite. */}
      <button
        type="button"
        className={RAIL_BUTTON}
        title={dock === "right" ? "Move the Shell to the bottom" : "Move the Shell to the right"}
        aria-label={dock === "right" ? "Move the Shell to the bottom" : "Move the Shell to the right"}
        data-shell-dock={dock}
        data-mode={mode}
        onClick={toggleShellDock}
      >
        {dock === "right" ? (
          <PanelBottom className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      <span className="flex-1" />

      <AgentRail ctx={ctx} only={SHELL_PLUGINS} embedded />

      {position === "bottom" && logo && <span className="my-1 h-px w-4 bg-white/[0.08]" aria-hidden />}
      {position === "bottom" && logo}
    </div>
  )
}
