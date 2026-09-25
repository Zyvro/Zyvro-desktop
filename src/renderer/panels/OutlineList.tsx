import { useState, useSyncExternalStore } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { outlineState, subscribeOutline } from "~/state/outline"
import { editorStatusOf, subscribeEditorStatus } from "~/state/editorStatus"
import { focusedTabId, useWorkspace } from "~/state/workspace"
import { revealAt } from "~/state/reveal"
import { itemAt } from "../../shared/outline"

// La section Outline, en bas de l'Explorateur, comme VS Code : repliée par
// défaut (elle prend la place de l'arbre), dépliée, elle suit le curseur et
// un clic mène au symbole.

const CLE = "zyvro.outlineOpen"
function ouverteAuDepart(): boolean {
  try {
    return localStorage.getItem(CLE) === "1"
  } catch {
    return false
  }
}

// Une lettre et une couleur par sorte de symbole, lisibles d'un coup d'œil.
const SORTES: Record<string, { lettre: string; couleur: string }> = {
  function: { lettre: "ƒ", couleur: "text-violet-300" },
  method: { lettre: "m", couleur: "text-violet-300" },
  constructor: { lettre: "c", couleur: "text-violet-300" },
  class: { lettre: "C", couleur: "text-amber-300" },
  interface: { lettre: "I", couleur: "text-sky-300" },
  type: { lettre: "T", couleur: "text-sky-300" },
  enum: { lettre: "E", couleur: "text-amber-300" },
  property: { lettre: "p", couleur: "text-sky-200" },
  getter: { lettre: "p", couleur: "text-sky-200" },
  setter: { lettre: "p", couleur: "text-sky-200" },
  const: { lettre: "c", couleur: "text-emerald-300" },
  let: { lettre: "v", couleur: "text-emerald-300" },
  var: { lettre: "v", couleur: "text-emerald-300" },
  heading: { lettre: "#", couleur: "text-muted-foreground" },
}

export function OutlineList() {
  const [ouverte, setOuverte] = useState(ouverteAuDepart)
  const etat = useSyncExternalStore(subscribeOutline, outlineState, outlineState)
  const tabId = useWorkspace((s) => focusedTabId(s))
  const statut = useSyncExternalStore(subscribeEditorStatus, () => editorStatusOf(tabId), () => null)
  const courant = statut ? itemAt(etat.items, statut.line) : -1

  const basculer = () => {
    const v = !ouverte
    setOuverte(v)
    try {
      localStorage.setItem(CLE, v ? "1" : "0")
    } catch {
      // Se souvenir est un confort.
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-col border-t border-white/[0.06]", ouverte ? "max-h-[40%] shrink" : "shrink-0")}>
      <button className="flex items-center gap-1 px-2 py-2 text-left" onClick={basculer} data-outline-toggle>
        {ouverte ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Outline</span>
      </button>
      {ouverte && (
        <div className="zy-scroll min-h-0 overflow-y-auto pb-2" data-outline>
          {!etat.path ? (
            <p className="px-3 text-[12px] text-muted-foreground">Open a file to see its symbols.</p>
          ) : !etat.supported ? (
            <p className="px-3 text-[12px] text-muted-foreground">No outline for this kind of file.</p>
          ) : etat.items.length === 0 ? (
            <p className="px-3 text-[12px] text-muted-foreground">No symbols in this file.</p>
          ) : (
            etat.items.map((item, i) => {
              const sorte = SORTES[item.kind] ?? { lettre: "·", couleur: "text-muted-foreground" }
              return (
                <button
                  key={`${item.line}:${item.column}:${item.name}`}
                  className={cn(
                    "flex w-full items-center gap-1.5 truncate py-[2px] pr-2 text-left text-[12.5px] hover:bg-white/[0.05]",
                    i === courant ? "bg-white/[0.07] text-foreground" : "text-foreground/85"
                  )}
                  style={{ paddingLeft: 12 + item.depth * 12 }}
                  title={`${item.name} — line ${item.line}`}
                  onClick={() => revealAt({ path: etat.path as string, line: item.line - 1, column: item.column - 1, length: item.name.length })}
                >
                  <span className={cn("w-3 shrink-0 text-center font-mono text-[11px]", sorte.couleur)}>{sorte.lettre}</span>
                  <span className="truncate">{item.name}</span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
