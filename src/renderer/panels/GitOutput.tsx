import { useQuery } from "@tanstack/react-query"
import { gitKey } from "~/lib/git"

// Every git command this window has run, with what git said back.
//
// It exists because a panel that turns each failure into a sentence of its own
// eventually meets one it has no sentence for — a credential helper that timed
// out, a hook that refused, a remote that answered with a redirect. The command
// and git's own words explain more than we ever could, and VS Code keeps this
// for the same reason.

export function GitOutput() {
  const log = useQuery({
    queryKey: [...gitKey, "output"],
    queryFn: () => window.zyvro.git.output(),
    refetchInterval: 2000,
  })

  const entries = log.data ?? []

  return (
    <div className="zy-scroll h-full overflow-auto p-3 font-mono text-[12px] leading-relaxed">
      {entries.length === 0 && <p className="text-muted-foreground">No git command has run yet.</p>}
      {entries.map((entry, index) => (
        <div key={`${entry.at}:${index}`} className="mb-1">
          <span className="text-muted-foreground">{entry.at.slice(11, 19)}</span>{" "}
          <span className={entry.code === 0 ? "text-foreground/85" : "text-red-400"}>
            git {entry.args.join(" ")}
          </span>{" "}
          <span className="text-muted-foreground">({entry.ms} ms)</span>
          {entry.stderr && (
            <pre className="ml-[4.5rem] whitespace-pre-wrap text-amber-300/80">{entry.stderr}</pre>
          )}
        </div>
      ))}
    </div>
  )
}
