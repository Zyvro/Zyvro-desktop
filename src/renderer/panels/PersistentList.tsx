import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, TerminalSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { askOpen } from "~/state/persistent"
import { askConfirm, askName } from "~/state/prompt"

// Les shells qui survivent à l'application.
//
// Demandé par Jeremy, à cette place précise : « on voit apparaître le shell
// persistant dans un emplacement entre Browsers et Workflows, avec le nom de la
// fenêtre ». C'est la bonne place — ce sont des choses qu'on ouvre et qu'on
// ferme au même rythme qu'une vue de navigateur, et qui appartiennent au projet
// comme un workflow.
//
// La différence avec un shell ordinaire tient en une phrase : celui-ci n'est
// pas notre enfant. `tmux` ou `screen` le tient, nous n'en sommes que le
// client, et fermer l'onglet — ou la fenêtre, ou l'application — le **détache**
// au lieu de le tuer. Mesuré sur le `screen` d'Apple avant d'être écrit.
//
// La section ne s'affiche pas du tout quand aucun des deux n'est là : sur
// Windows il n'en existe aucun portage natif, et une section vide qui explique
// pourquoi serait une explication à lire chaque jour pour une fonction qu'on
// n'aura jamais.

const KEY = ["local", "persistent"] as const

export function PersistentList() {
  const project = useWorkspace((s) => s.project)
  // En mode IA il n'y a pas de terminal du tout — c'est la différence entre les
  // deux modes, pas un panneau qu'on aurait fermé. Une section dont chaque
  // ligne serait inerte y serait pire qu'une section absente : « un menu qui
  // propose quand même est un menu dont la moitié déçoit ».
  //
  // Vérifié à l'écran avant d'être corrigé : la section s'y affichait, et
  // cliquer une ligne ne faisait rien, faute de panneau pour prendre la
  // demande. C'est très probablement ce que Jeremy a touché en disant « je le
  // ferme puis je clique sur la row et rien ne se passe ».
  const mode = useWorkspace((s) => s.mode)
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)

  const dispo = useQuery({
    queryKey: ["local", "persistent", "manager"],
    queryFn: () => window.zyvro.persistent.available(),
    staleTime: Infinity,
  })

  const sessions = useQuery({
    queryKey: KEY,
    queryFn: () => window.zyvro.persistent.list(),
    enabled: project !== null && Boolean(dispo.data),
    // Une session peut naître ou mourir hors de l'application — dans un
    // terminal, ou parce qu'elle a fini. Se rafraîchir doucement vaut mieux que
    // montrer une liste d'hier ; assez doucement pour ne pas lancer un
    // `screen -ls` par seconde.
    refetchInterval: 10_000,
  })

  if (!project || !dispo.data || mode === "ai") return null
  const liste = sessions.data ?? []

  const ouvrir = async (label: string): Promise<void> => {
    askOpen(label)
    // La liste se rafraîchit après l'ouverture : une session neuve n'existe
    // qu'une fois attachée, et c'est le panneau du bas qui l'attache.
    setTimeout(() => void client.invalidateQueries({ queryKey: KEY }), 1200)
  }

  const nouvelle = async (): Promise<void> => {
    const nom = await askName({
      title: "New persistent shell",
      label: `Kept alive by ${dispo.data} — closing Zyvro detaches it instead of killing it.`,
      confirmLabel: "Open",
    })
    const propre = nom?.trim()
    if (!propre) return
    setBusy(true)
    try {
      await ouvrir(propre)
    } finally {
      setBusy(false)
    }
  }

  // Tuer, ce que fermer l'onglet ne fait pas. Sans ce geste, une session
  // oubliée tourne des semaines — et on demande, parce qu'elle contient
  // justement ce qu'on avait pris soin de ne pas perdre.
  const tuer = async (name: string, label: string): Promise<void> => {
    const oui = await askConfirm({
      title: `Kill “${label}”?`,
      label: `Everything running in it stops. Closing its tab would only detach it.`,
      confirmLabel: "Kill session",
    })
    if (!oui) return
    await window.zyvro.persistent.kill(name)
    void client.invalidateQueries({ queryKey: KEY })
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-white/[0.06]">
      <header className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Persistent shells
        </span>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground disabled:opacity-40"
          title={`New persistent shell — kept by ${dispo.data}, survives closing Zyvro`}
          disabled={busy}
          onClick={() => void nouvelle()}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </header>

      {liste.length === 0 ? (
        <p className="px-3 pb-2 text-[12px] leading-relaxed text-muted-foreground">
          A shell {dispo.data} keeps running when Zyvro closes. Your dev server is still there when you come back.
        </p>
      ) : (
        <div className="zy-scroll max-h-40 overflow-y-auto pb-2">
          {liste.map((shell) => (
            <div key={shell.name} className="group flex w-full items-center gap-1 px-2 py-[3px] text-[12px] hover:bg-white/[0.05]">
              <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => void ouvrir(shell.label)}>
                <TerminalSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{shell.label}</span>
                {/* « Attaché » veut dire qu'une autre fenêtre — ou un terminal
                    ouvert à côté — la regarde déjà. L'ouvrir ici l'y reprendra,
                    ce qui se dit avant plutôt qu'après. */}
                {shell.attached && (
                  <span className={cn("shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10px] text-muted-foreground")}>
                    attached
                  </span>
                )}
              </button>
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
                title="Kill this session — closing its tab only detaches it"
                onClick={() => void tuer(shell.name, shell.label)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
