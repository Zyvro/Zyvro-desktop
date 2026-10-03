import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

// Une section de la barre latérale qu'on peut replier.
//
// Même contrat qu'Outline, et pour la même raison : ces trois listes prennent
// la place de l'arbre dès qu'il y en a, et quelqu'un qui n'a pas de browser
// ouvert ne devrait pas lire sa description au premier plan.
//
// L'indication d'éléments vit sur l'en-tête REPLIÉ : c'est le moment où l'on
// décide d'ouvrir, et un badge qui ne se voit que déplié ne sert à rien.

export function SidebarSection({
  id,
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: {
  /** La clé localStorage : `zyvro.section.<id>`. */
  id: string
  title: string
  /** Combien d'éléments. Un badge apparaît dès qu'il y en a, replié compris. */
  count?: number
  defaultOpen?: boolean
  actions?: ReactNode
  children: ReactNode
}) {
  const CLE = `zyvro.section.${id}`
  const [open, setOpen] = useState(() => {
    try {
      const raw = localStorage.getItem(CLE)
      return raw === null ? defaultOpen : raw === "1"
    } catch {
      return defaultOpen
    }
  })

  const basculer = (): void => {
    const v = !open
    setOpen(v)
    try {
      localStorage.setItem(CLE, v ? "1" : "0")
    } catch {
      // Se souvenir est un confort.
    }
  }

  return (
    <div className={cn("flex min-h-0 flex-col border-t border-white/[0.06]", open ? "shrink" : "shrink-0")}>
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left"
          onClick={basculer}
          data-section-toggle={id}
          title={open ? `Collapse ${title}` : `Expand ${title}`}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {/* Le compte ne ment pas : absent à zéro, présent dès qu'il y en a.
              C'est l'indication que la section replie attend, et elle se lit
              sans ouvrir. */}
          {typeof count === "number" && count > 0 && (
            <span
              className="shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10px] tabular-nums text-muted-foreground"
              title={`${count} item${count === 1 ? "" : "s"}`}
            >
              {count}
            </span>
          )}
        </button>
        {actions}
      </div>
      {open && children}
    </div>
  )
}
