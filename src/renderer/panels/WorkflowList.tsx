import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Cloud, Download, Link2, Loader2, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react"
import { api, type Workflow } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { workflowsKey } from "~/lib/project"
import { askConfirm, askName } from "~/state/prompt"
import { ImportWorkflows } from "~/panels/ImportWorkflows"
import { MyWorkflows } from "~/panels/MyWorkflows"
import { ShareWorkflow } from "~/panels/ShareWorkflow"

// The workflow list sits under the file tree because that is what the project
// actually contains: files, and the graphs that act on them. Clicking one opens
// the same editor the web app uses, in a tab.

const EMPTY_GRAPH = { nodes: [], edges: [] }

export function WorkflowList() {
  const project = useWorkspace((s) => s.project)
  const openGraph = useWorkspace((s) => s.openGraph)
  const closeTab = useWorkspace((s) => s.closeTab)
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const client = useQueryClient()
  const [importing, setImporting] = useState(false)
  const [mine, setMine] = useState(false)
  const [sharing, setSharing] = useState<Workflow | null>(null)

  const workflows = useQuery({
    queryKey: workflowsKey,
    queryFn: () => api.listWorkflows(),
    enabled: Boolean(project),
  })

  const create = useMutation({
    mutationFn: (name: string) => api.createWorkflow(name, EMPTY_GRAPH),
    onSuccess: (workflow: Workflow) => {
      void client.invalidateQueries({ queryKey: workflowsKey })
      openGraph(workflow.id, workflow.name)
    },
  })

  // Supprimer efface un fichier du projet, et rien ne le rattrape depuis
  // l'application : ce qui le rattrape est git, et seulement si le workflow y
  // était déjà. D'où la question avant, qui nomme le fichier.
  const remove = useMutation({
    mutationFn: (workflow: Workflow) => api.deleteWorkflow(workflow.id),
    onSuccess: (_answer, workflow) => {
      void client.invalidateQueries({ queryKey: workflowsKey })
      // L'onglet ouvert sur un graphe qui n'existe plus afficherait une erreur
      // de chargement : il se ferme avec lui.
      closeTab(`graph:${workflow.id}`)
    },
  })

  const askThenRemove = (workflow: Workflow): void => {
    void askConfirm({
      title: `Delete ${workflow.name}?`,
      label: `Its file goes from this project's .zyvro/workflows. If it is committed, git still has it; if it is not, nothing does.`,
      confirmLabel: "Delete",
    }).then((yes) => {
      if (yes) remove.mutate(workflow)
    })
  }

  if (!project) return null

  return (
    <div className="flex min-h-0 flex-col border-t border-white/[0.06]">
      <header className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Workflows
        </span>
        {workflows.isFetching && <Loader2 className="h-3 w-3 zy-spin text-muted-foreground" />}
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="My workflows on Zyvro"
          onClick={() => setMine(true)}
        >
          <Cloud className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="Import from another project"
          onClick={() => setImporting(true)}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground disabled:opacity-40"
          title="New workflow"
          disabled={create.isPending}
          onClick={() => {
            void askName({
              title: "New workflow",
              label: "It is saved in this project under .zyvro/workflows.",
              initial: "Untitled workflow",
            }).then((name) => {
              if (name) create.mutate(name)
            })
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="zy-scroll max-h-56 min-h-0 flex-1 overflow-y-auto pb-2">
        {workflows.isError && (
          <p className="px-3 pb-2 text-[12px] text-destructive">{(workflows.error as Error).message}</p>
        )}
        {create.isError && (
          <p className="px-3 pb-2 text-[12px] text-destructive">{(create.error as Error).message}</p>
        )}
        {remove.isError && (
          <p className="px-3 pb-2 text-[12px] text-destructive">{(remove.error as Error).message}</p>
        )}

        {workflows.data?.length === 0 && (
          <p className="px-3 pb-2 text-[12px] leading-relaxed text-muted-foreground">
            No workflows yet. They are stored in this project under .zyvro, so you can commit them
            alongside your code.
          </p>
        )}

        {(workflows.data ?? []).map((workflow) => {
          const isActive = activeTabId === `graph:${workflow.id}`
          return (
            <div
              key={workflow.id}
              className={cn(
                "group flex w-full items-center gap-2 py-[3px] pl-3 pr-2 text-left text-[13px] leading-5",
                isActive ? "bg-white/[0.08] text-foreground" : "text-foreground/80 hover:bg-white/[0.05]"
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => openGraph(workflow.id, workflow.name)}
                title={workflow.description || workflow.name}
              >
                <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                <span className="truncate">{workflow.name}</span>
              </button>
              {/* On the row rather than in the header: sharing is about one
                  workflow, and a header button would have to ask which. */}
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
                title="Share with a private link"
                onClick={() => setSharing(workflow)}
              >
                <Link2 className="h-3 w-3" />
              </button>
              {/* À côté du partage, et en rouge au survol : les deux gestes
                  portent sur la même ligne, et un seul ne se rattrape pas. */}
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-destructive/20 hover:text-destructive group-hover:opacity-100 disabled:opacity-40"
                title="Delete this workflow"
                disabled={remove.isPending}
                onClick={() => askThenRemove(workflow)}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>

      {importing && <ImportWorkflows onClose={() => setImporting(false)} />}
      {mine && <MyWorkflows onClose={() => setMine(false)} />}
      {sharing && <ShareWorkflow workflow={sharing} onClose={() => setSharing(null)} />}
    </div>
  )
}
