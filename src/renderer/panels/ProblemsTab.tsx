import { useSyncExternalStore } from "react"
import { AlertTriangle, Info, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { problems, subscribeProblems, type Problem } from "~/state/problems"
import { useWorkspace } from "~/state/workspace"
import { revealAt } from "~/state/reveal"
import { FileTypeIcon } from "~/lib/fileIcons"

// Le panneau Problems (⇧⌘M) : les erreurs et avertissements des fichiers
// ouverts, groupés par fichier, un clic pour aller à la ligne.

const ICONE = {
  error: <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />,
  warning: <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />,
  info: <Info className="h-3.5 w-3.5 shrink-0 text-sky-300" />,
}

function aller(p: Problem): void {
  useWorkspace.getState().openFile(p.path)
  revealAt({ path: p.path, line: p.line - 1, column: p.column - 1, length: 0 })
}

export function ProblemsTab() {
  const liste = useSyncExternalStore(subscribeProblems, problems, problems)
  const parFichier = new Map<string, Problem[]>()
  for (const p of liste) parFichier.set(p.path, [...(parFichier.get(p.path) ?? []), p])

  if (liste.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
        No problems in the open files.
      </div>
    )
  }
  return (
    <div className="zy-scroll h-full overflow-y-auto py-2 text-[13px]">
      {[...parFichier.entries()].map(([path, items]) => (
        <div key={path} className="mb-1">
          <div className="flex items-center gap-1.5 px-3 py-1 text-foreground">
            <FileTypeIcon name={path.split("/").pop() ?? path} className="h-3.5 w-3.5" />
            <span>{path.split("/").pop()}</span>
            <span className="truncate text-[12px] text-muted-foreground">{path}</span>
            <span className="ml-1 rounded-full bg-white/[0.08] px-1.5 text-[10px] text-muted-foreground">{items.length}</span>
          </div>
          {items.map((p, i) => (
            <button
              key={i}
              className={cn("flex w-full items-start gap-2 py-0.5 pl-8 pr-3 text-left hover:bg-white/[0.05]")}
              onClick={() => aller(p)}
            >
              {ICONE[p.severity]}
              <span className="min-w-0 flex-1 text-foreground/90">{p.message}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {p.source} [Ln {p.line}, Col {p.column}]
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

// Le compteur de la barre d'état, comme celui de VS Code : erreurs et
// avertissements, un clic ouvre le panneau.
export function ProblemsPill() {
  const liste = useSyncExternalStore(subscribeProblems, problems, problems)
  const erreurs = liste.filter((p) => p.severity === "error").length
  const avertissements = liste.filter((p) => p.severity === "warning").length
  return (
    <button
      className="flex items-center gap-2 rounded px-1 hover:bg-white/[0.08] hover:text-foreground"
      title="Problems (⇧⌘M)"
      onClick={() => useWorkspace.getState().openProblems()}
    >
      <span className="flex items-center gap-0.5">
        <XCircle className="h-3 w-3" /> {erreurs}
      </span>
      <span className="flex items-center gap-0.5">
        <AlertTriangle className="h-3 w-3" /> {avertissements}
      </span>
    </button>
  )
}
