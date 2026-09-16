import { useQuery } from "@tanstack/react-query"
import { Check, CircleSlash, Cpu } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"

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

      <div className="flex-1" />
      {dirtyCount > 0 && (
        <span className="text-foreground/80">
          {dirtyCount} unsaved file{dirtyCount === 1 ? "" : "s"}
        </span>
      )}
    </footer>
  )
}
