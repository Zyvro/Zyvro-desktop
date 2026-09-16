import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentKind } from "../../preload"
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
}: {
  kind: AgentKind
  /** The pinned model, or null for whatever the CLI picks. */
  model: string | null
  /** What the CLI reported running last, if it has run at all. */
  ranWith: string | null
  onChange: (model: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const aliases = useQuery({
    queryKey: ["agent", "models", kind],
    queryFn: () => window.zyvro.agent.models(kind),
    staleTime: Infinity,
  })

  // Before the first turn there is nothing to report, so the label says what it
  // knows and no more.
  const label = model ?? (ranWith ? `${ranWith} (default)` : "Default model")

  const choose = (value: string | null) => {
    setOpen(false)
    onChange(value)
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        title={
          model
            ? `This conversation is pinned to ${model}`
            : ranWith
              ? `${kind} chose ${ranWith}; nothing is pinned`
              : `Whatever ${kind} picks`
        }
        className="flex max-w-[11rem] items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground outline-none hover:bg-white/[0.06] hover:text-foreground data-[state=open]:bg-white/[0.06]"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="panel z-50 min-w-[190px] p-1" align="end" sideOffset={4}>
          <Menu.Item className={item} onSelect={() => choose(null)}>
            <Check className={cn("h-3 w-3", model ? "opacity-0" : "opacity-100")} />
            {ranWith ? `${ranWith} (default)` : "Default model"}
          </Menu.Item>

          {(aliases.data ?? []).length > 0 && (
            <Menu.Separator className="my-1 h-px bg-white/[0.08]" />
          )}
          {(aliases.data ?? []).map((alias) => (
            <Menu.Item key={alias} className={item} onSelect={() => choose(alias)}>
              <Check className={cn("h-3 w-3", model === alias ? "opacity-100" : "opacity-0")} />
              {alias}
            </Menu.Item>
          ))}

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
