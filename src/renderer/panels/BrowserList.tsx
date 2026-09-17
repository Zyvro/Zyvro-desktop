import { useState } from "react"
import { Globe, Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"

// Les vues de navigateur ouvertes, dans la barre latérale.
//
// Elles sont déjà des onglets de l'éditeur, alors pourquoi les lister ici : on
// en ouvre plusieurs — la page qu'on teste, celle de connexion, la version en
// ligne à comparer — et la barre d'onglets les nomme toutes « Browser » jusqu'à
// ce que leur page ait un titre. Ici on voit l'adresse sous le titre, donc on
// sait laquelle est laquelle sans cliquer dedans.
//
// Et c'est la liste qu'un agent nomme : chaque ligne porte l'identifiant que
// `zyvro_browser_open` accepte, ce qui rend visible ce que l'agent pilote.

export function BrowserList() {
  const project = useWorkspace((s) => s.project)
  const tabs = useWorkspace((s) => s.tabs)
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const activateTab = useWorkspace((s) => s.activateTab)
  const closeTab = useWorkspace((s) => s.closeTab)
  const openBrowser = useWorkspace((s) => s.openBrowser)

  if (!project) return null
  const views = tabs.filter((t) => t.kind === "browser")

  return (
    <div className="flex shrink-0 flex-col border-t border-white/[0.06]">
      <header className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Browser
        </span>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="New browser view — a page the agent can drive, in its own session"
          onClick={() => openBrowser()}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </header>

      {views.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] leading-relaxed text-muted-foreground">
          A page inside the IDE, with its own session — so an agent checking its work never touches your own browser.
        </p>
      ) : (
        <div className="zy-scroll max-h-40 overflow-y-auto pb-2">
          {views.map((view) => {
            const isActive = activeTabId === view.id
            return (
              <div
                key={view.id}
                className={cn(
                  "group flex w-full items-center gap-2 py-[3px] pl-3 pr-2 text-left text-[13px] leading-5",
                  isActive ? "bg-white/[0.08] text-foreground" : "text-foreground/80 hover:bg-white/[0.05]"
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => activateTab(view.id)}
                  title={`${view.url || "empty"} — an agent reaches this one as ${view.id}`}
                >
                  {/* La clé remonte le composant quand l'icône change : sans
                      elle, une icône qui avait échoué resterait un globe même
                      après qu'on a changé de page. */}
                  <Favicon key={view.icon} icon={view.icon} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{view.title}</span>
                    {view.url && (
                      <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                        {shortUrl(view.url)}
                      </span>
                    )}
                  </span>
                </button>
                <button
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
                  title="Close this view"
                  onClick={() => closeTab(view.id)}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Favicon : celle de la page, et le globe quand il n'y en a pas ou qu'elle ne
// se charge pas.
//
// Elle est chargée par l'application, pas par la vue : c'est une requête de
// plus vers ce site, pour une image que la page vient déjà de chercher. C'est
// le prix d'un onglet qui se reconnaît d'un coup d'œil, et il se paie sur les
// sites qu'on a soi-même ouverts.
export function Favicon({ icon, className }: { icon?: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (!icon || broken) return <Globe className={cn("h-3.5 w-3.5 shrink-0 text-sky-300", className)} />
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={icon}
      alt=""
      className={cn("h-3.5 w-3.5 shrink-0 rounded-[3px] object-contain", className)}
      onError={() => setBroken(true)}
    />
  )
}

// shortUrl : l'hôte et le chemin, sans le protocole. Dans une colonne de 260
// points, « https:// » prend la place du nom du site.
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`
  } catch {
    return url
  }
}
