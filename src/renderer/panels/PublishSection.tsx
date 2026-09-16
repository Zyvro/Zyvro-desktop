import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Box, Check, Loader2, Upload, Workflow as WorkflowIcon } from "lucide-react"
import { api, type Workflow } from "@/lib/api"
import type { InstalledPack } from "../../preload"
import { workflowsKey } from "~/lib/project"

// Publishing a workflow means publishing what it calls. The store derives a
// template's dependencies from its graph and refuses one whose node type
// belongs to no published pack, so the honest thing here is to catch that
// refusal, say which packs are missing, and offer to send them first rather
// than leaving someone to work out the order themselves.

type MissingPacks = { types: string[]; packs: string[] }

// The server names the node types it could not resolve. Matching them back to
// installed packs is what turns "unknown_node_types: summarize" into a button.
function whichPacksProvide(types: string[], installed: InstalledPack[]): string[] {
  const names = new Set<string>()
  for (const pack of installed) {
    for (const file of Object.keys(pack.sources)) {
      // A pack's node types are not in its manifest, so the type is matched
      // against the file that defines it, which is the convention the loader
      // already relies on.
      const stem = file.replace(/\.lua$/, "").replace(/[_-]/g, "").toLowerCase()
      if (types.some((t) => t.replace(/[_-]/g, "").toLowerCase() === stem)) names.add(pack.name)
    }
  }
  return [...names]
}

function parseMissing(error: unknown, installed: InstalledPack[]): MissingPacks | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /unknown[_ ]node[_ ]types?[:\s]+([a-zA-Z0-9_,\s-]+)/i.exec(message)
  if (!match) return null
  const types = match[1]
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (types.length === 0) return null
  return { types, packs: whichPacksProvide(types, installed) }
}

export function PublishSection({ signedIn }: { signedIn: boolean }) {
  const client = useQueryClient()
  const [missing, setMissing] = useState<MissingPacks | null>(null)
  const [done, setDone] = useState<string[]>([])

  const packs = useQuery({
    queryKey: ["store", "installed"],
    queryFn: () => window.zyvro.store.installedPacks(),
  })

  const workflows = useQuery({ queryKey: workflowsKey, queryFn: () => api.listWorkflows() })

  const publishPack = useMutation({
    mutationFn: (name: string) => window.zyvro.store.publishPack(name),
    onSuccess: (_result, name) => {
      setDone((current) => [...current, `pack:${name}`])
      void client.invalidateQueries({ queryKey: ["store", "nodes"] })
    },
  })

  const publishWorkflow = useMutation({
    mutationFn: async (workflow: Workflow) => {
      const graph = typeof workflow.graph_json === "string" ? JSON.parse(workflow.graph_json) : workflow.graph_json
      return window.zyvro.store.publishWorkflow({
        name: workflow.name,
        description: workflow.description ?? "",
        graph,
      })
    },
    onSuccess: (_result, workflow) => {
      setMissing(null)
      setDone((current) => [...current, `workflow:${workflow.id}`])
      void client.invalidateQueries({ queryKey: ["store", "workflows"] })
    },
    onError: (error) => setMissing(parseMissing(error, packs.data ?? [])),
  })

  if (!signedIn) {
    return (
      <p className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-muted-foreground">
        Sign in to publish. Browsing and installing do not need an account.
      </p>
    )
  }

  const publishMissingFirst = async () => {
    if (!missing) return
    for (const name of missing.packs) await publishPack.mutateAsync(name)
    setMissing(null)
  }

  return (
    <div className="mt-4 space-y-6">
      <section>
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Box className="h-3.5 w-3.5" /> Node packs in this project
        </h2>
        {packs.data?.length === 0 && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            None installed. A pack lives in .zyvro/packs, so it travels with the project.
          </p>
        )}
        <div className="mt-2 space-y-1.5">
          {(packs.data ?? []).map((pack) => (
            <div key={pack.name} className="panel flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">
                  {pack.name} <span className="font-mono text-[11px] text-muted-foreground">{pack.version}</span>
                </p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {pack.description || "No description."} · {Object.keys(pack.sources).length} node
                  {Object.keys(pack.sources).length === 1 ? "" : "s"}
                </p>
              </div>
              <PublishButton
                busy={publishPack.isPending && publishPack.variables === pack.name}
                done={done.includes(`pack:${pack.name}`)}
                onClick={() => publishPack.mutate(pack.name)}
              />
            </div>
          ))}
        </div>
        {publishPack.isError && (
          <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
            {(publishPack.error as Error).message}
          </p>
        )}
      </section>

      <section>
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <WorkflowIcon className="h-3.5 w-3.5" /> Workflows in this project
        </h2>
        <div className="mt-2 space-y-1.5">
          {(workflows.data ?? []).map((workflow) => (
            <div key={workflow.id} className="panel flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{workflow.name}</p>
                <p className="truncate text-[12px] text-muted-foreground">
                  {workflow.description || "No description."}
                </p>
              </div>
              <PublishButton
                busy={publishWorkflow.isPending && publishWorkflow.variables?.id === workflow.id}
                done={done.includes(`workflow:${workflow.id}`)}
                onClick={() => publishWorkflow.mutate(workflow)}
              />
            </div>
          ))}
        </div>

        {missing && (
          <div className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] p-3 text-[12px]">
            <p className="text-foreground/85">
              This workflow calls {missing.types.join(", ")}, which the store does not have yet. A
              published workflow has to be installable by whoever finds it, so its nodes go first.
            </p>
            {missing.packs.length > 0 ? (
              <button
                className="mt-2 rounded-lg bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                disabled={publishPack.isPending}
                onClick={() => void publishMissingFirst()}
              >
                Publish {missing.packs.join(", ")} first
              </button>
            ) : (
              <p className="mt-1 text-muted-foreground">
                No installed pack provides them, so they cannot be published from this project.
              </p>
            )}
          </div>
        )}

        {publishWorkflow.isError && !missing && (
          <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
            {(publishWorkflow.error as Error).message}
          </p>
        )}
      </section>
    </div>
  )
}

function PublishButton({ busy, done, onClick }: { busy: boolean; done: boolean; onClick: () => void }) {
  return (
    <button
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.1] px-2.5 py-1.5 text-[12px] hover:bg-white/[0.06] disabled:opacity-50"
      disabled={busy || done}
      onClick={onClick}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 zy-spin" />
      ) : done ? (
        <Check className="h-3.5 w-3.5 text-emerald-300" />
      ) : (
        <Upload className="h-3.5 w-3.5" />
      )}
      {done ? "Published" : "Publish"}
    </button>
  )
}
