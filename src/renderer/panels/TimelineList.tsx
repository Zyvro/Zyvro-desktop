import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronRight, GitCommitHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import { gitKey } from "~/lib/git"
import { focusedTabId, useWorkspace } from "~/state/workspace"
import { isAbsolutePath } from "../../shared/external"
import { relativeDate } from "../../shared/gitlog"

// La Timeline, en bas de l'Explorateur comme dans VS Code : les commits du
// fichier qu'on regarde, renommages suivis ; un clic ouvre ce que ce commit y a
// changé, côte à côte. Repliée par défaut, retenue ouverte.

const CLE = "zyvro.timelineOpen"
function ouverteAuDepart(): boolean {
  try {
    return localStorage.getItem(CLE) === "1"
  } catch {
    return false
  }
}

export function TimelineList() {
  const [ouverte, setOuverte] = useState(ouverteAuDepart)
  // Le fichier de l'onglet regardé — un fichier, ou un diff de ce fichier : en
  // ouvrant un commit depuis la Timeline, on garde son histoire sous les yeux.
  const path = useWorkspace((s) => {
    const id = focusedTabId(s)
    const tab = s.tabs.find((t) => t.id === id)
    const p = tab && (tab.kind === "file" || tab.kind === "diff") ? tab.path : null
    return p && !isAbsolutePath(p) ? p : null
  })
  const journal = useQuery({
    queryKey: [...gitKey, "file-log", path],
    queryFn: () => window.zyvro.git.fileLog(path as string),
    enabled: ouverte && path !== null,
    staleTime: 30_000,
  })

  const basculer = () => {
    const v = !ouverte
    setOuverte(v)
    try {
      localStorage.setItem(CLE, v ? "1" : "0")
    } catch {
      // Se souvenir est un confort.
    }
  }

  const commits = journal.data ?? []
  return (
    <div className={cn("flex min-h-0 flex-col border-t border-white/[0.06]", ouverte ? "max-h-[35%] shrink" : "shrink-0")}>
      <button className="flex items-center gap-1 px-2 py-2 text-left" onClick={basculer} data-timeline-toggle>
        {ouverte ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Timeline</span>
      </button>
      {ouverte && (
        <div className="zy-scroll min-h-0 overflow-y-auto pb-2" data-timeline>
          {!path ? (
            <p className="px-3 text-[12px] text-muted-foreground">Open a file to see its history.</p>
          ) : journal.isLoading ? (
            <p className="px-3 text-[12px] text-muted-foreground">Reading the history…</p>
          ) : commits.length === 0 ? (
            <p className="px-3 text-[12px] text-muted-foreground">No commits for this file yet.</p>
          ) : (
            commits.map((c) => (
              <button
                key={c.hash}
                className="flex w-full items-center gap-1.5 py-[3px] pl-3 pr-2 text-left text-[12.5px] hover:bg-white/[0.05]"
                title={`${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString()} · ${c.short}${c.path !== path ? `\n${c.path}` : ""}`}
                onClick={() => useWorkspace.getState().openCommitDiff(c.path, c.hash, c.short)}
              >
                <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground/90">{c.subject || c.short}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate(c.date)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
