import { useState, useSyncExternalStore } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { ArrowUpCircle, Check, Loader2, TriangleAlert } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  dismissUpdate,
  getSnapshot,
  installUpdate,
  subscribe,
} from "~/state/engineUpdate"

// The engine is the part of this app that runs with the user's privileges, so
// it is never updated behind their back. An available release shows up here and
// stays until they act on it, which is the whole bargain that makes an
// automatic check acceptable in the first place.

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function EngineUpdateNotice() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [open, setOpen] = useState(false)

  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.round((state.receivedBytes / state.totalBytes) * 100) : 0
    return (
      <span className="flex items-center gap-1.5 text-primary/90">
        <Loader2 className="h-3 w-3 zy-spin" />
        Downloading engine {state.manifest.version} · {pct}%
      </span>
    )
  }

  if (state.status === "installed") {
    return (
      <span className="flex items-center gap-1.5 text-emerald-300/90" title="It will be used the next time a project opens.">
        <Check className="h-3 w-3" />
        Engine {state.version} installed · reopen the project to use it
      </span>
    )
  }

  if (state.status !== "available") return null

  return (
    <>
      <button
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
        onClick={() => setOpen(true)}
        title={`You are on ${state.current}`}
      >
        <ArrowUpCircle className="h-3 w-3" />
        Engine {state.manifest.version} available
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content className="panel fixed left-1/2 top-1/3 z-50 w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5">
            <Dialog.Title className="text-sm font-semibold">
              Update the local engine to {state.manifest.version}?
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              The engine runs your workflows on this machine. You are on{" "}
              <span className="font-mono text-foreground">{state.current}</span>.
            </Dialog.Description>

            {state.manifest.notes && (
              <p className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.03] p-2.5 text-[12px] leading-relaxed">
                {state.manifest.notes}
              </p>
            )}

            <dl className="mt-3 space-y-1 text-[11px] text-muted-foreground">
              <div className="flex justify-between">
                <dt>Download</dt>
                <dd className="font-mono text-foreground/80">{formatSize(state.manifest.size)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Published</dt>
                <dd className="font-mono text-foreground/80">
                  {new Date(state.manifest.released_at).toLocaleDateString()}
                </dd>
              </div>
            </dl>

            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              The download is checked against the signature of the Zyvro release key before
              anything is installed, and the current engine is kept in case the new one fails
              to start.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                onClick={() => {
                  setOpen(false)
                  void dismissUpdate()
                }}
              >
                Not now
              </button>
              <button
                className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
                onClick={() => {
                  setOpen(false)
                  void installUpdate()
                }}
              >
                Update
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

// The failure case is deliberately quiet. A machine that is offline, or behind a
// proxy that blocks the update host, must not nag: the app works perfectly well
// on the engine it already has.
export function EngineUpdateProblem() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  if (state.status !== "failed") return null
  return (
    <span className={cn("flex items-center gap-1.5 text-muted-foreground/60")} title={state.message}>
      <TriangleAlert className="h-3 w-3" />
      Update check failed
    </span>
  )
}
