import { useState, useSyncExternalStore } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { Bug, Check, Copy, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { markReported, subscribeIncidents, unreportedIncidents } from "~/state/bugReport"
import { RAIL_BUTTON } from "./railButton"

// Le bouton bug et sa fenêtre.
//
// Un clic ouvre la fenêtre : on y dit ce qui s'est passé, et l'envoi emporte
// avec la description l'état complet de l'application à cet instant — les
// conversations ouvertes, ce que le processus principal tient de chaque tour
// d'agent, les erreurs vues depuis le dernier rapport. C'est l'état qui permet
// de comprendre un tour bloqué sur « Writing… », pas la description seule.
//
// Le bouton rougit quand une erreur est entrée au journal : l'application a vu
// quelque chose casser, et c'est le bon moment pour le dire.

export function BugButton({ snapshot }: { snapshot: () => unknown }): JSX.Element {
  const [open, setOpen] = useState(false)
  const count = useSyncExternalStore(subscribeIncidents, unreportedIncidents, () => 0)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={count > 0 ? `Report a bug — ${count} error${count > 1 ? "s" : ""} recorded since the last report` : "Report a bug"}
        aria-label="Report a bug"
        className={cn(
          RAIL_BUTTON,
          count > 0 ? "text-red-300 hover:text-red-200" : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Bug className="h-3.5 w-3.5" />
        {count > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-400" aria-hidden />}
      </button>
      {open && <BugReportDialog snapshot={snapshot} incidents={count} onClose={() => setOpen(false)} />}
    </>
  )
}

type Sending = { phase: "idle" } | { phase: "sending" } | { phase: "sent"; id: string } | { phase: "failed"; message: string }

export function BugReportDialog({
  snapshot,
  incidents,
  onClose,
}: {
  snapshot: () => unknown
  incidents: number
  onClose: () => void
}): JSX.Element {
  const [description, setDescription] = useState("")
  const [sending, setSending] = useState<Sending>({ phase: "idle" })
  const [copied, setCopied] = useState(false)

  const send = async () => {
    if (sending.phase === "sending") return
    setSending({ phase: "sending" })
    try {
      // L'état est pris au moment de l'envoi, pas à l'ouverture : ce qu'on
      // décrit est ce qui est à l'écran maintenant.
      const id = await window.zyvro.bug.report(incidents > 0 ? "crash" : "manual", description, snapshot())
      markReported()
      setSending({ phase: "sent", id })
    } catch (err) {
      setSending({ phase: "failed", message: err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err) })
    }
  }

  const copy = async (id: string) => {
    await navigator.clipboard.writeText(id).catch(() => {})
    setCopied(true)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="panel fixed left-1/2 top-1/4 z-50 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5">
          <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
            <Bug className="h-4 w-4 text-red-300" />
            Report a bug
          </Dialog.Title>

          {sending.phase === "sent" ? (
            <>
              <Dialog.Description className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                Thanks — the report was sent. Quote this id if you write to us about it:
              </Dialog.Description>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-[12px] text-foreground">{sending.id}</code>
                <button
                  type="button"
                  onClick={() => void copy(sending.id)}
                  className="rounded-md border border-white/[0.12] p-1.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  title="Copy the id"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={onClose} className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90">
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <Dialog.Description className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                What happened, and what did you expect? The report also carries the app&apos;s complete state right now: your open
                conversations, the agent turns in progress and their last output, and the errors recorded since the last report
                {incidents > 0 ? ` (${incidents} so far)` : ""}. Keys and tokens of known shapes are masked; anything else in your
                conversations is sent as it is.
              </Dialog.Description>
              <textarea
                autoFocus
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void send()
                  }
                }}
                placeholder="e.g. The agent showed “Writing…” forever and Stop did nothing."
                rows={5}
                className="mt-3 w-full resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
              />
              {sending.phase === "failed" && (
                <p className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  The report was not sent: {sending.message}
                </p>
              )}
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-white/[0.12] px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending.phase === "sending"}
                  className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                >
                  {sending.phase === "sending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send report
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
