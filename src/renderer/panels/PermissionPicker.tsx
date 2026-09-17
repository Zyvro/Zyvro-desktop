import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, Eye, FolderCheck, HandCoins, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentKind } from "../../preload"
import { PERMISSIONS, type Permission } from "../../shared/permission"

// Ce que l'agent a le droit de faire, choisi à côté de la question qu'on lui
// pose.
//
// C'est là que ça se décide parce que c'est là qu'on hésite : on écrit
// « refais-moi ce fichier » et on veut savoir, avant d'appuyer, s'il va le
// faire ou demander. Un réglage dans une page de préférences serait un réglage
// qu'on met une fois et qu'on oublie — et qu'on découvre en lisant « permission
// refusée » au milieu d'une réponse.

type Level = {
  value: Permission
  label: string
  hint: string
  icon: typeof Eye
  /** Ce que codex fait de ce niveau, quand ce n'est pas la même chose. */
  codex?: string
}

const LEVELS: Level[] = [
  {
    value: "project",
    label: "Workspace",
    hint: "Everything inside this project, no questions.",
    icon: FolderCheck,
  },
  {
    value: "ask",
    label: "Ask",
    hint: "It asks before each action, and you answer here.",
    icon: HandCoins,
    // codex exec n'a pas de crochet d'approbation : sa réponse est son bac à
    // sable, décidé d'avance. Le dire plutôt que de laisser croire.
    codex: "codex cannot ask mid-turn — it stays inside the project instead.",
  },
  {
    value: "read",
    label: "Read only",
    hint: "It looks and answers. It never writes, never runs anything.",
    icon: Eye,
  },
  {
    value: "yolo",
    label: "YOLO",
    hint: "Anything, anywhere, without asking. Including outside this project.",
    icon: Zap,
  },
]

// Un niveau décrit ici pour chaque valeur de la liste partagée : en oublier un
// le rendrait inatteignable depuis le menu, sans que rien ne le signale.
if (LEVELS.length !== PERMISSIONS.length) {
  throw new Error(`the permission menu is missing a level: ${PERMISSIONS.join(", ")}`)
}

export function PermissionPicker({
  value,
  kind,
  onChange,
  disabled,
}: {
  value: Permission
  kind: AgentKind
  onChange: (value: Permission) => void
  disabled?: boolean
}) {
  const current = LEVELS.find((level) => level.value === value) ?? LEVELS[0]
  const Icon = current.icon

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        title={`${current.label} — ${current.hint}`}
        className={cn(
          "mb-[1px] flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] outline-none hover:bg-white/[0.08] disabled:opacity-40 data-[state=open]:bg-white/[0.08]",
          value === "yolo" ? "text-amber-300" : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Content className="panel z-50 w-[19rem] p-1" align="start" side="top" sideOffset={6}>
          {LEVELS.map((level) => (
            <Menu.Item
              key={level.value}
              onSelect={() => onChange(level.value)}
              className="flex cursor-default items-start gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-white/[0.06]"
            >
              <Check className={cn("mt-[2px] h-3 w-3 shrink-0", value === level.value ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  <level.icon className="h-3.5 w-3.5" />
                  {level.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{level.hint}</span>
                {kind === "codex" && level.codex && (
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-amber-300/80">{level.codex}</span>
                )}
              </span>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
