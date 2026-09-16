import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Box,
  Check,
  Download,
  Loader2,
  LogIn,
  Search,
  ShieldAlert,
  Upload,
  Workflow as WorkflowIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { StoreListing, StoreWorkflow } from "../../preload"
import { useWorkspace } from "~/state/workspace"
import { useAccount } from "~/lib/account"
import { SignInDialog } from "~/panels/SignInDialog"
import { PackSource } from "~/panels/PackSource"
import { PublishSection } from "~/panels/PublishSection"

// The store distributes source, never behaviour: everything it hands over runs
// locally, in the sandbox, on this machine. That is why reading a pack's Lua is
// a first-class action here rather than something buried. It is the only review
// a small store gets.

type Section = "nodes" | "workflows" | "publish"

// A capability is the one thing in a listing worth reading before installing.
// Most packs ask for nothing or for llm; anything else is worth a second look,
// so the interesting ones are tinted and the ordinary ones are not.
const LOUD_CAPABILITIES = new Set(["files", "image", "vision", "agent"])

function Capabilities({ capabilities }: { capabilities: string[] }) {
  if (!capabilities || capabilities.length === 0) {
    return <span className="text-[11px] text-muted-foreground">no capabilities</span>
  }
  return (
    <span className="flex flex-wrap gap-1">
      {capabilities.map((capability) => (
        <span
          key={capability}
          className={cn(
            "rounded px-1 py-px text-[10px] uppercase tracking-wide",
            LOUD_CAPABILITIES.has(capability)
              ? "bg-amber-400/15 text-amber-300"
              : "bg-white/[0.07] text-muted-foreground"
          )}
        >
          {capability}
        </span>
      ))}
    </span>
  )
}

export function StorePanel() {
  const project = useWorkspace((s) => s.project)
  const [section, setSection] = useState<Section>("nodes")
  const [search, setSearch] = useState("")
  const [reading, setReading] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const account = useAccount()
  const client = useQueryClient()

  const nodes = useQuery({
    queryKey: ["store", "nodes", search],
    queryFn: () => window.zyvro.store.nodes(search),
    enabled: section === "nodes",
  })

  const workflows = useQuery({
    queryKey: ["store", "workflows", search],
    queryFn: () => window.zyvro.store.workflows(search),
    enabled: section === "workflows",
  })

  const install = useMutation({
    mutationFn: async (what: { kind: Section; name: string }) =>
      what.kind === "nodes"
        ? window.zyvro.store.installPack(what.name)
        : window.zyvro.store.installWorkflow(what.name),
    onSuccess: () => {
      // A freshly installed pack changes what the palette can offer and what
      // the project holds, so both have to be re-read.
      void client.invalidateQueries({ queryKey: ["local"] })
      void client.invalidateQueries({ queryKey: ["files"] })
    },
  })

  const listing = section === "nodes" ? nodes : workflows
  const items = (listing.data ?? []) as (StoreListing | StoreWorkflow)[]

  return (
    <div className="zy-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <header className="flex items-start gap-4">
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Store</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Nodes and workflows written by other people. Everything runs on this machine, in the
              sandbox, and you can read the source before installing.
            </p>
          </div>
          {account.data ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-muted-foreground">
              <Check className="h-3.5 w-3.5 text-emerald-300" />
              {account.data.email}
            </span>
          ) : (
            <button
              className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] hover:bg-white/[0.06]"
              onClick={() => setSigningIn(true)}
            >
              <LogIn className="h-3.5 w-3.5" /> Sign in to publish
            </button>
          )}
        </header>

        <div className="mt-6 flex items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
            {(["nodes", "workflows", "publish"] as Section[]).map((value) => (
              <button
                key={value}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] capitalize",
                  section === value ? "bg-white/[0.09] text-foreground" : "text-muted-foreground"
                )}
                onClick={() => setSection(value)}
              >
                {value === "nodes" ? (
                  <Box className="h-3.5 w-3.5" />
                ) : value === "workflows" ? (
                  <WorkflowIcon className="h-3.5 w-3.5" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {value}
              </button>
            ))}
          </div>

          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] pl-8 pr-3 text-[13px] outline-none focus:border-primary/50 disabled:opacity-40"
              disabled={section === "publish"}
              placeholder={section === "publish" ? "Your own packs and workflows" : `Search ${section}`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>

        {!project && (
          <p className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-muted-foreground">
            Open a project to install anything. A pack is installed into the project that uses it, not
            into the app.
          </p>
        )}

        {listing.isError && (
          <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {(listing.error as Error).message}
          </p>
        )}
        {install.isError && (
          <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {(install.error as Error).message}
          </p>
        )}

        {section === "publish" && <PublishSection signedIn={Boolean(account.data)} />}

        <div className={cn("mt-4 space-y-2", section === "publish" && "hidden")}>
          {listing.isLoading && (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 zy-spin" /> Loading
            </p>
          )}

          {listing.isSuccess && items.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">
              Nothing published yet{search ? ` for “${search}”` : ""}.
            </p>
          )}

          {items.map((item) => {
            const isWorkflow = section === "workflows"
            const workflow = item as StoreWorkflow
            const pack = item as StoreListing
            const busy = install.isPending && install.variables?.name === item.name

            return (
              <article key={item.name} className="panel p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="flex items-center gap-2 text-sm font-medium">
                      {item.name}
                      {!isWorkflow && (
                        <span className="font-mono text-[11px] text-muted-foreground">{pack.version}</span>
                      )}
                    </h2>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                      {item.description || "No description."}
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span>by {item.author || "unknown"}</span>
                      {!isWorkflow && <Capabilities capabilities={pack.capabilities} />}
                      {isWorkflow && workflow.requires?.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Download className="h-3 w-3" />
                          pulls {workflow.requires.length} pack
                          {workflow.requires.length === 1 ? "" : "s"}:{" "}
                          {workflow.requires.map((r) => `${r.name}@${r.version}`).join(", ")}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 gap-1.5">
                    {!isWorkflow && (
                      <button
                        className="rounded-lg border border-white/[0.1] px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                        onClick={() => setReading(reading === item.name ? null : item.name)}
                      >
                        {reading === item.name ? "Hide source" : "Read source"}
                      </button>
                    )}
                    <button
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      disabled={!project || busy}
                      onClick={() => install.mutate({ kind: section, name: item.name })}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 zy-spin" /> : <Download className="h-3.5 w-3.5" />}
                      Install
                    </button>
                  </div>
                </div>

                {reading === item.name && !isWorkflow && (
                  <div className="mt-3 border-t border-white/[0.06] pt-3">
                    <PackSource name={item.name} />
                  </div>
                )}
              </article>
            )
          })}
        </div>

        <footer className="mt-8 flex gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[12px] leading-relaxed">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p className="text-foreground/80">
            Installing runs someone else&apos;s code on your machine. The sandbox bounds what it can
            do to processor time and your model quota, and a pack can only touch your files if it
            declares the capability, which you can see above. Nothing here is reviewed by us.
          </p>
        </footer>
      </div>

      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} />}
    </div>
  )
}
