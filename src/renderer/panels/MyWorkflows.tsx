import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as Dialog from "@radix-ui/react-dialog"
import { Check, Cloud, Loader2, Workflow as WorkflowIcon } from "lucide-react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import type { HostedWorkflow } from "../../preload"
import { workflowsKey } from "~/lib/project"
import { useWorkspace } from "~/state/workspace"
import { useAccount } from "~/lib/account"
import { SignInDialog } from "~/panels/SignInDialog"

// The workflows on your account, brought down into the project you have open.
//
// They are a different set from the ones in the project: a workflow made on the
// web lives as a row on the server, one made here lives as a file under
// `.zyvro/`. Neither is the other's copy, which is why this is an import and
// not a sync — a sync would have to decide which side wins, and nobody asked
// for that decision.

export function MyWorkflows({ onClose }: { onClose: () => void }) {
  const account = useAccount()
  const [signingIn, setSigningIn] = useState(false)
  const [done, setDone] = useState<string[]>([])
  const client = useQueryClient()
  const openGraph = useWorkspace((s) => s.openGraph)

  const hosted = useQuery({
    queryKey: ["account", "workflows"],
    queryFn: () => window.zyvro.workflows.mine(),
    enabled: Boolean(account.data),
  })

  const bring = useMutation({
    mutationFn: async (workflow: HostedWorkflow) => {
      // graph_json arrives as text, and the local API takes a graph. Sending
      // the string would store a string.
      const graph = JSON.parse(workflow.graph_json || "{}") as unknown
      return api.createWorkflow(workflow.name, graph, workflow.description)
    },
    onSuccess: (created, workflow) => {
      setDone((current) => [...current, workflow.id])
      void client.invalidateQueries({ queryKey: workflowsKey })
      openGraph(created.id, created.name)
    },
  })

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content className="panel fixed left-1/2 top-1/4 z-50 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              My workflows
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Everything on your Zyvro account. Importing makes a copy in the project you have open,
              so it becomes a file that travels with your code.
            </Dialog.Description>

            {!account.data ? (
              <button
                className="mt-4 w-full rounded-lg border border-white/[0.1] px-3 py-2 text-[13px] hover:bg-white/[0.06]"
                onClick={() => setSigningIn(true)}
              >
                Sign in to see them
              </button>
            ) : hosted.isLoading ? (
              <p className="mt-4 flex items-center gap-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 zy-spin" /> Asking the server
              </p>
            ) : hosted.isError ? (
              <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {(hosted.error as Error).message}
              </p>
            ) : (hosted.data ?? []).length === 0 ? (
              <p className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-muted-foreground">
                Your account has no workflows yet.
              </p>
            ) : (
              <div className="zy-scroll mt-3 max-h-72 space-y-1 overflow-y-auto">
                {(hosted.data ?? []).map((workflow) => {
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
                          {workflow.visibility}
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

            {bring.isError && (
              <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {(bring.error as Error).message}
              </p>
            )}

            <div className="mt-4 flex justify-end">
              <button
                className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                onClick={onClose}
              >
                {done.length > 0 ? "Done" : "Close"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} />}
    </>
  )
}
