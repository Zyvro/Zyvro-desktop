import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Download, Loader2, Plus, Workflow as WorkflowIcon } from "lucide-react"
import { api, type Workflow } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { workflowsKey } from "~/lib/project"
import { askName } from "~/state/prompt"
import { ImportWorkflows } from "~/panels/ImportWorkflows"

// The workflow list sits under the file tree because that is what the project
// actually contains: files, and the graphs that act on them. Clicking one opens
// the same editor the web app uses, in a tab.

const EMPTY_GRAPH = { nodes: [], edges: [] }

export function WorkflowList() {
  const project = useWorkspace((s) => s.project)
  const openGraph = useWorkspace((s) => s.openGraph)
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const client = useQueryClient()
  const [importing, setImporting] = useState(false)

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

        {workflows.data?.length === 0 && (
          <p className="px-3 pb-2 text-[12px] leading-relaxed text-muted-foreground">
            No workflows yet. They are stored in this project under .zyvro, so you can commit them
            alongside your code.
          </p>
        )}

        {(workflows.data ?? []).map((workflow) => {
          const isActive = activeTabId === `graph:${workflow.id}`
          return (
            <button
              key={workflow.id}
              className={cn(
                "flex w-full items-center gap-2 py-[3px] pl-3 pr-2 text-left text-[13px] leading-5",
                isActive ? "bg-white/[0.08] text-foreground" : "text-foreground/80 hover:bg-white/[0.05]"
              )}
              onClick={() => openGraph(workflow.id, workflow.name)}
              title={workflow.description || workflow.name}
            >
              <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-violet-300" />
              <span className="truncate">{workflow.name}</span>
            </button>
          )
        })}
      </div>

      {importing && <ImportWorkflows onClose={() => setImporting(false)} />}
    </div>
  )
}
