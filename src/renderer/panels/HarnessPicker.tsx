import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSyncExternalStore } from "react"
import { AGENT_KINDS, HARNESSES, harnessEnabled, isChatKind, type AgentKind } from "../../shared/harness"
import { getSettings, subscribeSettings } from "~/state/settings"
import { IMAGE_ICONS, SVG_ICONS } from "~/lib/harnessIcons"

// Le choix du harnais, en menu avec logo et nom.
//
// Demandé par Jeremy : les quatre boutons « claude codex qwen mimo » côte à
// côte étaient un réglage qu'on lisait mot à mot. Un menu, chacun avec sa
// marque à gauche et son vrai nom, se reconnaît d'un coup d'œil — et il a la
// place de dire, sous le nom, ce que ce harnais est et s'il est installé.

type HarnessInfo = { name: string; vendor: string }

/** Le nom qu'on lit, et de qui il vient. */
export const HARNESS_INFO = Object.fromEntries(
  AGENT_KINDS.map((kind) => [kind, { name: HARNESSES[kind].name, vendor: HARNESSES[kind].vendor }])
) as Record<AgentKind, HarnessInfo>

// Une marque noire (Copilot, Cursor, OpenCode) sur le fond sombre de
// l'application disparaîtrait : sa tuile s'éclaircit juste assez pour se voir.
function tuile(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 40 ? "#2A2A31" : hex
}

// La teinte d'un harnais sans marque dessinée : tirée de son nom, stable d'un
// lancement à l'autre.
function teinte(kind: string): number {
  let h = 0
  for (const c of kind) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

// Les marques : celles de lib/harnessIcons en priorité ; sinon une tuile
// dessinée ici, aux couleurs de chacune.
export function HarnessMark({ kind, className }: { kind: AgentKind; className?: string }): JSX.Element {
  const box = cn("shrink-0", className ?? "h-4 w-4")
  // La marque de l'éditeur d'abord (lib/harnessIcons) : son tracé officiel en
  // blanc sur sa couleur, ou son image. Les dessins ci-dessous ne servent plus
  // que si l'une manquait.
  const svg = SVG_ICONS[kind]
  if (svg) {
    return (
      <svg viewBox="0 0 24 24" className={box} aria-hidden="true" data-harness-icon={kind}>
        <rect width="24" height="24" rx="6" fill={tuile(svg.hex)} />
        <path d={svg.path} fill="#FFFFFF" transform="translate(4.6 4.6) scale(0.6167)" />
      </svg>
    )
  }
  const image = IMAGE_ICONS[kind]
  if (image) {
    return <img src={image} alt="" aria-hidden="true" draggable={false} data-harness-icon={kind} className={cn(box, "rounded-[22%] object-cover ring-1 ring-inset ring-white/15")} />
  }
  switch (kind) {
    case "claude":
      // L'étincelle orange d'Anthropic : huit rayons autour d'un cœur.
      return (
        <svg viewBox="0 0 24 24" className={box} aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="#D97757" />
          <g stroke="#FFF5EF" strokeWidth="2.1" strokeLinecap="round">
            <path d="M12 4.6v4.2M12 15.2v4.2M4.6 12h4.2M15.2 12h4.2M6.8 6.8l3 3M14.2 14.2l3 3M17.2 6.8l-3 3M9.8 14.2l-3 3" />
          </g>
          <circle cx="12" cy="12" r="1.7" fill="#FFF5EF" />
        </svg>
      )
    case "codex":
      // Le nœud d'OpenAI, sur fond sombre comme son terminal.
      return (
        <svg viewBox="0 0 24 24" className={box} aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="#0E1512" />
          <path
            d="M12 5.2c1.3 0 2.4.6 3.1 1.6.8-.2 1.7 0 2.4.6.8.8 1 2 .6 3 .8.7 1.3 1.7 1.3 2.9 0 1.3-.6 2.4-1.6 3.1.2.8 0 1.7-.6 2.4-.8.8-2 1-3 .6-.7.8-1.7 1.3-2.9 1.3-1.3 0-2.4-.6-3.1-1.6-.8.2-1.7 0-2.4-.6-.8-.8-1-2-.6-3-.8-.7-1.3-1.7-1.3-2.9 0-1.3.6-2.4 1.6-3.1-.2-.8 0-1.7.6-2.4.8-.8 2-1 3-.6.7-.8 1.7-1.3 2.9-1.3Z"
            fill="none"
            stroke="#6EE7B7"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12.6" r="2.2" fill="none" stroke="#6EE7B7" strokeWidth="1.5" />
        </svg>
      )
    case "qwen":
      // Une tuile violette et un hexagone ouvert, comme la marque de Qwen.
      return (
        <svg viewBox="0 0 24 24" className={box} aria-hidden="true">
          <rect width="24" height="24" rx="6" fill="#6D4AFF" />
          <path
            d="M12 4.8 18.3 8.4v7.2L12 19.2 5.7 15.6V8.4Z"
            fill="none"
            stroke="#F3EEFF"
            strokeWidth="1.9"
            strokeLinejoin="round"
          />
          <path d="M12 9.2 14.6 12 12 14.8 9.4 12Z" fill="#F3EEFF" />
        </svg>
      )
    case "mimo":
      // L'orange Xiaomi et un « mi » blanc.
      return (
        <svg viewBox="0 0 24 24" className={box} aria-hidden="true">
          <rect width="24" height="24" rx="7" fill="#FF6900" />
          <path
            d="M5.6 16.4V8.2h6.1c1.6 0 2.6 1 2.6 2.6v5.6M8.6 16.4v-5.2M11.3 16.4v-5.2M17.4 8.2v8.2"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    default: {
      // Les autres : une tuile à leur teinte et l'initiale de leur nom — pas
      // de logo déposé reproduit.
      const nom = HARNESSES[kind]?.name ?? kind
      return (
        <svg viewBox="0 0 24 24" className={box} aria-hidden="true">
          <rect width="24" height="24" rx="6" fill={`hsl(${teinte(kind)} 55% 38%)`} />
          <text x="12" y="16.4" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
            {nom.slice(0, 1).toUpperCase()}
          </text>
        </svg>
      )
    }
  }
}

const item =
  "flex cursor-default select-none items-center gap-2.5 rounded px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-white/[0.09]"

export function HarnessPicker({
  kind,
  onChange,
  installed,
  className,
  chatOnly = false,
}: {
  kind: AgentKind
  onChange: (kind: AgentKind) => void
  /** Pour caler le déclencheur sur ses voisins (hauteur, police). */
  className?: string
  /** Ce qui est installé sur la machine ; un harnais absent le dit, et le choisir
   *  amène la bannière qui l'installe. */
  installed: (kind: AgentKind) => boolean
  /** Le panneau de conversation : seulement les harnais dont il lit la sortie. */
  chatOnly?: boolean
}): JSX.Element {
  const current = HARNESS_INFO[kind]
  // Les harnais allumés (la page Harness Providers), et celui déjà choisi même éteint.
  const agent = useSyncExternalStore(subscribeSettings, getSettings).agent
  const options = AGENT_KINDS.filter(
    (option) => option === kind || (harnessEnabled(agent, option) && (!chatOnly || isChatKind(option)))
  )
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "flex max-w-full items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.04] py-1 pl-1.5 pr-2 text-[12px] text-foreground outline-none transition-colors hover:bg-white/[0.08] data-[state=open]:bg-white/[0.08]",
          className
        )}
        title={`Harness: ${current.name} (${current.vendor})`}
      >
        <HarnessMark kind={kind} />
        <span className="truncate font-medium">{current.name}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="panel zy-scroll z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-[230px] overflow-y-auto p-1"
          align="end"
          sideOffset={4}
          collisionPadding={8}
        >
          {options.map((option) => {
            const info = HARNESS_INFO[option]
            const present = installed(option)
            return (
              <Menu.Item key={option} className={item} onSelect={() => onChange(option)}>
                <HarnessMark kind={option} className="h-6 w-6" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-foreground">{info.name}</span>
                  <span className={cn("block truncate text-[10.5px]", present ? "text-muted-foreground" : "text-amber-300/90")}>
                    {present ? info.vendor : `${info.vendor} · not installed`}
                  </span>
                </span>
                <Check className={cn("h-3.5 w-3.5 shrink-0 text-primary", option === kind ? "opacity-100" : "opacity-0")} />
              </Menu.Item>
            )
          })}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
