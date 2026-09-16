import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import * as Dialog from "@radix-ui/react-dialog"
import { Check, FolderOpen, Loader2, Workflow as WorkflowIcon } from "lucide-react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { Importable, ImportableWorkflow } from "../../preload"
import { workflowsKey } from "~/lib/project"
import { useWorkspace } from "~/state/workspace"

// Bringing a workflow over from another project.
//
// A workflow is a JSON file under `.zyvro/workflows/`, which is the whole
// reason this is possible: the thing you want is already sitting in whatever
// repository it belongs to. What makes it awkward by hand is knowing that,
// finding the file, and getting the graph out of it without breaking the
// wrapper around it.
//
// The copy is made by the open project's own daemon rather than by writing a
// file: it owns ids and slugs, and it would have to be told about a new file
// anyway. So the import is a create, and the imported workflow is as ordinary
// as one you drew yourself.

export function ImportWorkflows({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState<Importable | null>(null)
  const [error, setError] = useState("")
  const [done, setDone] = useState<string[]>([])
  const client = useQueryClient()
  const openGraph = useWorkspace((s) => s.openGraph)

  const browse = useMutation({
    mutationFn: () => window.zyvro.workflows.chooseSource(),
    onSuccess: (found) => {
      if (found) {
        setSource(found)
        setError("")
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  const bring = useMutation({
    mutationFn: async (workflow: ImportableWorkflow) => {
      // The graph is parsed here rather than sent as text: the API takes a
      // graph, and a string would arrive as a string and be stored as one.
      const graph = JSON.parse(workflow.graphJSON) as unknown
      return api.createWorkflow(workflow.name, graph, workflow.description)
    },
    onSuccess: (created, workflow) => {
      setDone((current) => [...current, workflow.id])
      void client.invalidateQueries({ queryKey: workflowsKey })
      // Opened straight away when it is the only one: importing one workflow
      // and then having to find it in the list is a step nobody wanted.
      if (source?.workflows.length === 1) {
        openGraph(created.id, created.name)
        onClose()
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="panel fixed left-1/2 top-1/4 z-50 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5">
          <Dialog.Title className="text-sm font-semibold">Import workflows</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            From another Zyvro project on this machine. The copy is made in the project you have
            open, so it travels with it like any other workflow.
          </Dialog.Description>

          {!source ? (
            <button
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-white/[0.1] px-3 py-2 text-[13px] hover:bg-white/[0.06] disabled:opacity-50"
              disabled={browse.isPending}
              onClick={() => browse.mutate()}
            >
              {browse.isPending ? <Loader2 className="h-3.5 w-3.5 zy-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
              Choose a project folder…
            </button>
          ) : (
            <>
              <p className="mt-4 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <FolderOpen className="h-3.5 w-3.5" />
                <span className="truncate">{source.name}</span>
                <button
                  className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] hover:bg-white/[0.06] hover:text-foreground"
                  onClick={() => browse.mutate()}
                >
                  Change
                </button>
              </p>

              {source.workflows.length === 0 ? (
                <p className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-muted-foreground">
                  That project has no workflows yet.
                </p>
              ) : (
                <div className="zy-scroll mt-2 max-h-72 space-y-1 overflow-y-auto">
                  {source.workflows.map((workflow) => {
                    const imported = done.includes(workflow.id)
                    const busy = bring.isPending && bring.variables?.id === workflow.id
                    return (
                      <div
                        key={workflow.id}
                        className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
                      >
                        <WorkflowIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px]">{workflow.name}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {workflow.nodes} node{workflow.nodes === 1 ? "" : "s"}
                            {workflow.description ? ` · ${workflow.description}` : ""}
                          </p>
                        </div>
                        <button
                          className={cn(
                            "shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium",
                            imported
                              ? "text-emerald-300"
                              : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                          )}
                          disabled={busy || imported}
                          onClick={() => bring.mutate(workflow)}
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 zy-spin" />
                          ) : imported ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            "Import"
                          )}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {error && (
            <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <button
              className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              onClick={onClose}
            >
              {done.length > 0 ? "Done" : "Cancel"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
