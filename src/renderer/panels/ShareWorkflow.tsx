import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import * as Dialog from "@radix-ui/react-dialog"
import { Check, Copy, ExternalLink, Link2, Loader2 } from "lucide-react"
import { api, type Workflow } from "@/lib/api"
import { useAccount } from "~/lib/account"
import { SignInDialog } from "~/panels/SignInDialog"

// Sending a workflow to somebody.
//
// A copy goes up to the account as an *unlisted* workflow — reachable by
// whoever holds the link, listed nowhere — and the link is the page that
// already exists for shared workflows, which offers to copy it into the
// visitor's own space. Nothing new was needed on the server for any of that.
//
// A copy, deliberately: what you sent is a snapshot. Editing the graph tomorrow
// does not rewrite what somebody was sent today, which is what "I sent you
// this" ought to mean. Saying so here matters more than it looks — the opposite
// assumption is the one people make.

export function ShareWorkflow({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const account = useAccount()
  const [signingIn, setSigningIn] = useState(false)
  const [copied, setCopied] = useState(false)

  const share = useMutation({
    mutationFn: async () => {
      // The graph is read fresh rather than taken from the list: the list may
      // be a few seconds old, and sending a workflow that is not quite the one
      // on screen is the kind of thing nobody notices until it matters.
      const full = await api.getWorkflow(workflow.id)
      const graph =
        typeof full.graph_json === "string" ? JSON.parse(full.graph_json) : full.graph_json
      return window.zyvro.workflows.share({
        name: full.name,
        description: full.description ?? "",
        graph,
      })
    },
  })

  const link = share.data?.url ?? ""

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content className="panel fixed left-1/2 top-1/3 z-50 w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
              <Link2 className="h-4 w-4 text-muted-foreground" />
              Share “{workflow.name}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              A copy goes to your Zyvro account, unlisted: it appears in no catalogue, and only
              somebody holding the link can open it. They can copy it into their own space from
              there.
            </Dialog.Description>

            {!account.data ? (
              <button
                className="mt-4 w-full rounded-lg border border-white/[0.1] px-3 py-2 text-[13px] hover:bg-white/[0.06]"
                onClick={() => setSigningIn(true)}
              >
                Sign in to share
              </button>
            ) : !link ? (
              <button
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                disabled={share.isPending}
                onClick={() => share.mutate()}
              >
                {share.isPending && <Loader2 className="h-3.5 w-3.5 zy-spin" />}
                Create a private link
              </button>
            ) : (
              <>
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{link}</span>
                  <button
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                    title="Copy the link"
                    onClick={() => {
                      void navigator.clipboard.writeText(link)
                      setCopied(true)
                    }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                    title="Open it"
                    onClick={() => void window.zyvro.openExternal(link)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  This is a snapshot. Editing the workflow here afterwards does not change what you
                  just sent.
                </p>
              </>
            )}

            {share.isError && (
              <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {(share.error as Error).message}
              </p>
            )}

            <div className="mt-4 flex justify-end">
              <button
                className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                onClick={onClose}
              >
                {link ? "Done" : "Cancel"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {signingIn && <SignInDialog onClose={() => setSigningIn(false)} />}
    </>
  )
}
