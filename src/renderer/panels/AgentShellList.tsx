import { Pencil, Plus, X } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { recordTitle, type AgentShellRecord } from "../../shared/agentShell"
import { useWorkspace } from "~/state/workspace"
import { askAgent } from "~/state/persistent"
import { openLauncher } from "~/state/launcher"
import { askConfirm, askName } from "~/state/prompt"
import { refreshAgentShells, useAgentShells } from "~/state/agentShells"
import { SidebarSection } from "~/panels/SidebarSection"
import { HarnessMark } from "./HarnessPicker"

// Les sessions d'agent natif du projet : celles qui tournent, et celles qu'on
// reprend d'un clic.
//
// Le harnais garde sa conversation (`~/.claude/projects`, `~/.codex/sessions`) ;
// Zyvro garde de quoi la retrouver — l'identifiant de session et la
// configuration qui l'a lancée. Cliquer une ligne rouvre l'agent dans un onglet
// avec `--resume`, la même permission et le même modèle qu'à l'origine ; si elle
// tourne déjà, on va à son onglet.

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (!Number.isFinite(seconds)) return ""
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86_400)} d`
}

export function AgentShellList() {
  const project = useWorkspace((s) => s.root)
  const setPanel = useWorkspace((s) => s.setPanel)
  const { records, live } = useAgentShells()

  // Redemandée quand le dossier change ; ensuite le principal prévient de
  // chaque changement (state/agentShells). Aucun sondage.
  useQuery({
    queryKey: ["local", "agentshells", project],
    queryFn: async () => {
      await refreshAgentShells()
      return true
    },
    enabled: project !== null,
    staleTime: 0,
  })

  if (!project) return null

  const ouvrir = (record: AgentShellRecord): void => {
    setPanel("terminal", true)
    askAgent({
      kind: record.kind,
      model: record.model,
      permission: record.permission,
      effort: record.effort,
      instructions: record.instructions,
      mcp: record.mcp,
      skills: record.skills,
      name: record.name,
      prompt: "",
      profileId: record.profileId,
      resume: record.id,
      conversation: null,
      submit: false,
    })
  }

  const renommer = async (record: AgentShellRecord): Promise<void> => {
    const name = await askName({
      title: "Rename agent session",
      label: "The tab and this list use this name.",
      initial: recordTitle(record),
      confirmLabel: "Rename",
    })
    const clean = name?.trim()
    if (clean) await window.zyvro.agentShell.rename(record.id, clean)
  }

  const oublier = async (record: AgentShellRecord): Promise<void> => {
    const running = live.has(record.id)
    const oui = await askConfirm({
      title: `Remove “${recordTitle(record)}”?`,
      label: running
        ? "It is running: it stops, and Zyvro forgets how to resume it. The conversation itself stays in the harness's own history."
        : "Zyvro forgets how to resume it. The conversation itself stays in the harness's own history.",
      confirmLabel: "Remove",
      danger: true,
    })
    if (oui) await window.zyvro.agentShell.forget(record.id)
  }

  return (
    <SidebarSection
      id="agentshells"
      title="Agent sessions"
      count={records.length}
      actions={
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="Run an agent — pick its configuration and write the task"
          onClick={openLauncher}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      }
    >
      {records.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] leading-relaxed text-muted-foreground">
          An agent runs in a shell, in its own interface. Zyvro keeps its session id, so closing the app and coming back
          resumes the same conversation.
        </p>
      ) : (
        <div className="zy-scroll max-h-52 overflow-y-auto pb-2">
          {records.map((record) => {
            const running = live.has(record.id)
            return (
              <div key={record.id} className="group flex w-full items-center gap-1 px-2 py-[3px] text-[12px] hover:bg-white/[0.05]">
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => ouvrir(record)}>
                  <HarnessMark kind={record.kind} className="h-3.5 w-3.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{recordTitle(record)}</span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">
                      {record.model ?? "default model"} · {record.permission} · {ago(record.updatedAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      running ? "bg-emerald-400" : record.state === "open" ? "bg-amber-300/80" : "bg-white/20"
                    )}
                    title={running ? "Running" : record.state === "open" ? "Was open — reopens at startup" : "Closed — click to resume"}
                  />
                </button>
                <button
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
                  title="Rename"
                  onClick={() => void renommer(record)}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
                  title="Remove from the list"
                  onClick={() => void oublier(record)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </SidebarSection>
  )
}
