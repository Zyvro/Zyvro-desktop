import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentKind } from "../../preload"
import { harness } from "../../shared/harness"
import { askName } from "~/state/prompt"

// Which model this thread talks to.
//
// The default is the CLI's, and it is shown by its real name rather than as the
// word "default": the app asks the CLI what it actually ran and prints that.
// Anything else would be the app telling the person something it does not know
// — the default belongs to the tool, and it changes without asking us.
//
// The choices come from the CLI's own --help. Neither CLI has a
// machine-readable list of models, so it was a choice between writing the names
// down here and reading them where the tool states them. Written down they
// would be a second list: a new alias would appear in the CLI and never in this
// menu, and a retired one would stay in it and fail. The typed-in option is
// what covers a full model name, and what still works if the parse finds
// nothing at all.

const item =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-[12px] outline-none data-[highlighted]:bg-white/[0.09]"

export function ModelPicker({
  kind,
  model,
  ranWith,
  onChange,
  framed = false,
  className,
}: {
  /** Cadré comme un sélecteur de barre (lanceur), au lieu du texte nu d'un en-tête. */
  framed?: boolean
  className?: string
  kind: AgentKind
  /** The pinned model, or null for whatever the CLI picks. */
  model: string | null
  /** What the CLI reported running last, if it has run at all. */
  ranWith: string | null
  onChange: (model: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  // Un harnais visable ne choisit pas parmi SES modèles : il choisit parmi ceux
  // que vos serveurs font tourner en ce moment. « En ce moment » est le mot qui
  // compte — la liste d'un CLI ne bouge pas tant que l'application vit, celle
  // d'un serveur change dès qu'on charge autre chose.
  const vivante = harness(kind).aimable
  const aliases = useQuery({
    queryKey: ["agent", "models", kind],
    queryFn: () => window.zyvro.agent.models(kind),
    staleTime: vivante ? 0 : Infinity,
  })

  // Before the first turn there is nothing to report, so the label says what it
  // knows and no more.
  const label = model ?? (ranWith ? `${ranWith} (default)` : "Default model")

  const choose = (value: string | null) => {
    setOpen(false)
    onChange(value)
  }

  // Redemandée à l'ouverture du menu, et pas au montage seulement.
  //
  // Le défaut qu'on répare ici : charger un modèle dans LM Studio APRÈS avoir
  // ouvert le panneau donnait une liste vide qui le restait jusqu'au
  // redémarrage de l'application. Rien ne disait pourquoi — le menu s'ouvrait
  // sur « Default model » et rien d'autre, ce qui ressemble à une panne.
  //
  // À l'ouverture plutôt que par une minuterie : c'est le seul moment où
  // quelqu'un regarde, et interroger trois serveurs en boucle pour un menu
  // fermé serait du trafic que personne n'a demandé.
  const ouvrir = (next: boolean): void => {
    setOpen(next)
    if (next && vivante) void aliases.refetch()
  }

  const liste = aliases.data?.models ?? []
  // Les erreurs des serveurs (éteints, clef refusée…) ne sont plus montrées :
  // un serveur local éteint est un état normal, pas une panne à lire.

  return (
    <Menu.Root open={open} onOpenChange={ouvrir}>
      <Menu.Trigger
        title={
          model
            ? `This conversation is pinned to ${model}`
            : ranWith
              ? `${kind} chose ${ranWith}; nothing is pinned`
              : `Whatever ${kind} picks`
        }
        // Le bouton ne se borne plus lui-même : il prend ce que son conteneur
        // lui laisse. Le plafond (11rem) et la possibilité de rétrécir vivent
        // côte à côte dans la barre qui l'accueille, sinon les deux règles se
        // contredisent et c'est le voisin de droite qui sort de l'écran.
        className={cn(
          framed
            ? "flex max-w-full items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px] text-foreground outline-none transition-colors hover:bg-white/[0.08] data-[state=open]:bg-white/[0.08]"
            : "flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none hover:bg-white/[0.06] hover:text-foreground data-[state=open]:bg-white/[0.06]",
          className
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </Menu.Trigger>
      <Menu.Portal>
        {/* Pas plus haut que la fenêtre.

            Ce menu tenait en quatre lignes tant qu'il ne proposait que les
            alias d'un CLI. Le jour où les modèles des serveurs locaux sont
            entrés dedans, il y en a eu une trentaine : ouvert depuis l'en-tête
            d'une conversation, il descendait sous le bas de la fenêtre et la
            moitié de la liste était inatteignable.

            Un plafond, donc, et pas une direction. J'ai d'abord posé
            `side="top"` — le réflexe, parce que le sélecteur de permission juste
            à côté l'a. Mesuré, ce déclencheur-ci est à 137 px du haut, pas en
            bas : il n'y a pas de place au-dessus, Radix rebasculait vers le bas,
            et le drapeau ne décrivait rien de vrai. Ce qui corrige vraiment est
            le plafond, que Radix sait calculer des deux côtés :
            `--radix-…-available-height` est ce qu'il mesure entre le déclencheur
            et le bord de la fenêtre, `collisionPadding` laisse le jour qui
            empêche de coller à ce bord. Mesuré après : menu de 161 à 892 dans
            une fenêtre de 900, 660 px visibles pour 763 px de contenu. */}
        <Menu.Content
          className="panel z-50 flex max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[190px] max-w-[22rem] flex-col overflow-hidden p-1"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          <Menu.Item className={item} onSelect={() => choose(null)}>
            <Check className={cn("h-3 w-3", model ? "opacity-0" : "opacity-100")} />
            {ranWith ? `${ranWith} (default)` : "Default model"}
          </Menu.Item>

          {/* Ce qui défile est le milieu, pas le menu entier : le modèle par
              défaut en haut et « Other… » en bas restent sous la main. Sans ça,
              épingler un nom qu'on tape demanderait de faire défiler trente
              modèles pour atteindre la dernière ligne. */}
          <div className="zy-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {liste.length > 0 && <Menu.Separator className="my-1 h-px bg-white/[0.08]" />}

          {/* Une liste vide chez un harnais visable n'est pas une panne, c'est
              une phrase : aucun serveur allumé, ou rien de chargé dedans. Sans
              elle, le menu s'ouvre sur une seule ligne et a l'air cassé.
              Mais elle ne se dit que quand elle est vraie — un serveur qui a
              répondu autre chose qu'une liste a ses propres mots, et ce sont
              eux qui disent quoi faire. */}
          {vivante && liste.length === 0 && (
            <>
              <Menu.Separator className="my-1 h-px bg-white/[0.08]" />
              <div className="px-2 py-1 text-[11px] leading-snug text-muted-foreground">
                {aliases.isFetching
                  ? "Asking your servers what they are running…"
                  : "No local server is answering. Turn one on in Providers, load a model, and open this again."}
              </div>
            </>
          )}

          {liste.map((alias) => (
            <Menu.Item key={alias} className={item} onSelect={() => choose(alias)}>
              <Check className={cn("h-3 w-3 shrink-0", model === alias ? "opacity-100" : "opacity-0")} />
              {/* Tronqué plutôt qu'élargissant : « ollama-local/nemotron-3-nano:30b-cloud »
                  fait grandir le menu jusqu'à déborder par le côté, et il y en a
                  trente. Le nom entier reste lisible dans l'infobulle. */}
              <span className="truncate" title={alias}>
                {alias}
              </span>
            </Menu.Item>
          ))}
          </div>

          <Menu.Separator className="my-1 h-px bg-white/[0.08]" />
          <Menu.Item
            className={item}
            onSelect={async () => {
              const typed = await askName({
                title: "Pin a model",
                label: `Full model name, as ${kind} spells it`,
                confirmLabel: "Use it",
              })
              if (typed?.trim()) choose(typed.trim())
            }}
          >
            <Check className="h-3 w-3 opacity-0" />
            Other…
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
