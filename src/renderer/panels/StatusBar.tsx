import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Check, CircleSlash, Cpu, GitBranch, Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { gitActions, useGitAction, useGitStatus } from "~/lib/git"

// The one line that answers "can this project actually run anything right now".
// On a desktop app that question is mostly about which CLIs are installed, so
// that is what it leads with.

type LocalStatus = {
  project: string
  workflows: number
  cli: { claude: boolean; codex: boolean }
}

function CliPill({ name, ready }: { name: string; ready: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1",
        ready ? "text-emerald-300/90" : "text-muted-foreground/70"
      )}
      title={
        ready
          ? `${name} is installed; workflows can use your subscription through it.`
          : `${name} was not found on your PATH.`
      }
    >
      {ready ? <Check className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
      {name}
    </span>
  )
}

// The branch, where every editor puts it. It earns the corner because it
// answers a question people ask constantly and would otherwise open a panel
// for: which branch am I on, and am I out of step with the remote.
//
// Clicking it syncs, which is the pair of commands nobody wants to think about
// separately: bring down what is there, then send up what is not.
function GitPill() {
  const setPanel = useWorkspace((s) => s.setPanel)
  const status = useGitStatus()
  const pull = useGitAction(gitActions.pull)
  const push = useGitAction(gitActions.push)
  const repo = status.data?.repository ? status.data : null
  if (!repo) return null

  const busy = pull.isPending || push.isPending
  const sync = async () => {
    if (repo.behind > 0) await pull.mutateAsync(undefined)
    if (repo.ahead > 0) await push.mutateAsync(undefined)
  }
  const failure = (pull.error ?? push.error) as Error | null

  return (
    <span className="flex items-center gap-2">
      <button
        className="flex items-center gap-1 hover:text-foreground"
        title="Open source control"
        onClick={() => setPanel("git", true)}
      >
        <GitBranch className="h-3 w-3" />
        {repo.branch ?? `detached ${repo.head}`}
      </button>
      {repo.upstream && (
        <button
          className="flex items-center gap-0.5 hover:text-foreground disabled:opacity-60"
          disabled={busy}
          title={
            failure
              ? failure.message
              : repo.behind || repo.ahead
                ? `${repo.behind} to pull, ${repo.ahead} to push`
                : "Up to date with " + repo.upstream
          }
          onClick={() => void sync()}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 zy-spin" />
          ) : repo.behind === 0 && repo.ahead === 0 ? (
            <RefreshCw className="h-3 w-3" />
          ) : (
            <>
              {repo.behind > 0 && (
                <>
                  <ArrowDown className="h-3 w-3" />
                  {repo.behind}
                </>
              )}
              {repo.ahead > 0 && (
                <>
                  <ArrowUp className="h-3 w-3" />
                  {repo.ahead}
                </>
              )}
            </>
          )}
        </button>
      )}
      {failure && <span className="text-destructive">{failure.message}</span>}
    </span>
  )
}

export function StatusBar() {
  const project = useWorkspace((s) => s.project)
  const dirtyCount = useWorkspace((s) => Object.keys(s.drafts).length)

  const status = useQuery({
    queryKey: ["local", "status"],
    queryFn: async (): Promise<LocalStatus> => {
      const res = await fetch("http://127.0.0.1:0/api/local/status")
      if (!res.ok) throw new Error(`status ${res.status}`)
      return res.json() as Promise<LocalStatus>
    },
    enabled: Boolean(project),
    refetchInterval: 15_000,
  })

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-white/[0.06] bg-background px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <Cpu className="h-3 w-3" />
        {project ? `Local engine on port ${project.daemon.port}` : "No project open"}
      </span>

      {status.data && (
        <>
          <CliPill name="claude" ready={status.data.cli.claude} />
          <CliPill name="codex" ready={status.data.cli.codex} />
          <span>
            {status.data.workflows} workflow{status.data.workflows === 1 ? "" : "s"}
          </span>
        </>
      )}

      <GitPill />

      <div className="flex-1" />

      {/* The update offer lives here and stays here until the user acts on it,
          so an engine they chose not to install is never lost, only quiet. */}

      {dirtyCount > 0 && (
        <span className="text-foreground/80">
          {dirtyCount} unsaved file{dirtyCount === 1 ? "" : "s"}
        </span>
      )}
    </footer>
  )
}
