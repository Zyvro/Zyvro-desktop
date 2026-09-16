import { Clock, FolderOpen, Loader2, Terminal as TerminalIcon, Workflow } from "lucide-react"
import { useWorkspace } from "~/state/workspace"
import { forgetRecents, useOpenProject, useRecents } from "~/lib/project"

// Recent folders are dated relative to now because that is how anyone thinks
// about them: "the one from yesterday", never a timestamp.
function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString()
}

// The empty state has one job: get a folder open. Everything else in the window
// is inert until that happens, so this is not the place for a feature tour.

export function Welcome() {
  const project = useWorkspace((s) => s.project)
  const opening = useWorkspace((s) => s.opening)
  const openError = useWorkspace((s) => s.openError)
  const open = useOpenProject()
  const recents = useRecents()

  return (
    <div className="zy-scroll flex h-full items-center justify-center overflow-y-auto px-8">
      <div className="w-full max-w-lg py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Zyvro Studio</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Visual AI workflows next to the code they act on. Open a folder and its workflows load from{" "}
          <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[12px]">.zyvro</code>, ready to commit
          alongside everything else in the repository.
        </p>

        <button
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          disabled={opening || open.isPending}
          onClick={() => open.mutate(null)}
        >
          {opening || open.isPending ? (
            <Loader2 className="h-4 w-4 zy-spin" />
          ) : (
            <FolderOpen className="h-4 w-4" />
          )}
          {project ? "Open another project…" : "Open a project folder…"}
        </button>

        {openError && (
          <pre className="zy-selectable mt-4 whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[12px] leading-relaxed text-destructive">
            {openError}
          </pre>
        )}

        {(recents.data?.length ?? 0) > 0 && (
          <section className="mt-8">
            <header className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </h2>
              <button
                className="text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => void forgetRecents()}
              >
                Clear
              </button>
            </header>
            <ul className="mt-2">
              {recents.data?.map((recent) => (
                <li key={recent.path}>
                  <button
                    className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.05]"
                    onClick={() => open.mutate(recent.path)}
                    title={recent.path}
                  >
                    <span className="shrink-0 text-[13px] text-foreground">{recent.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                      {recent.path}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground/70">
                      {ago(recent.openedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <dl className="mt-10 space-y-5 text-[13px] leading-relaxed">
          <div className="flex gap-3">
            <TerminalIcon className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <div>
              <dt className="font-medium text-foreground">Your subscription, not an API key</dt>
              <dd className="mt-0.5 text-muted-foreground">
                Text nodes can run through the <code className="text-foreground">claude</code> or{" "}
                <code className="text-foreground">codex</code> command line tool installed here. A
                ChatGPT or Claude plan works directly, and no credential ever leaves this machine.
              </dd>
            </div>
          </div>
          <div className="flex gap-3">
            <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <div>
              <dt className="font-medium text-foreground">The same editor as the web app</dt>
              <dd className="mt-0.5 text-muted-foreground">
                Graphs open in a tab with the full node palette, live run status and image previews.
                A workflow built here opens unchanged on zyv.ro.
              </dd>
            </div>
          </div>
        </dl>
      </div>
    </div>
  )
}
