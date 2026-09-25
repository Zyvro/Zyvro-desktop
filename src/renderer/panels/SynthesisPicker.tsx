import { useSyncExternalStore } from "react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, Loader2, Sparkles, Wand2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { subscribeSynthesis, synthesisSettings, updateSynthesis } from "~/state/synthesis"
import { SYNTHESIS_MODES } from "../../shared/synthesize"

// L'auto-synthèse, à côté des droits de l'agent : là où l'on écrit.
// Le mode choisi réécrit chaque demande avant de l'envoyer ; « Send
// automatically » la laisse partir sans la relire ; « Rewrite now » réécrit la
// boîte tout de suite, pour voir ce que ça donne.

export function SynthesisPicker({
  disabled,
  busy,
  canRewrite,
  onRewriteNow,
}: {
  disabled?: boolean
  busy: boolean
  canRewrite: boolean
  onRewriteNow: () => void
}) {
  const r = useSyncExternalStore(subscribeSynthesis, synthesisSettings, synthesisSettings)
  const actif = r.mode !== "off"
  const courant = SYNTHESIS_MODES.find((m) => m.value === r.mode) ?? SYNTHESIS_MODES[0]
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        data-synthesis-trigger
        title={actif ? `Auto-synthesize: ${courant.label}${r.autoSend ? ", sent automatically" : ", review before sending"}` : "Auto-synthesize: off"}
        className={cn(
          "mb-[1px] flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] outline-none hover:bg-white/[0.08] disabled:opacity-40 data-[state=open]:bg-white/[0.08]",
          actif ? "text-sky-300" : "text-muted-foreground hover:text-foreground"
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 zy-spin" /> : <Sparkles className="h-3.5 w-3.5 shrink-0" />}
        {actif && <span className="hidden sm:inline">{courant.label.replace("Translate to ", "")}</span>}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="panel z-50 w-[19rem] p-1" align="start" side="top" sideOffset={6}>
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Auto-synthesize</p>
          {SYNTHESIS_MODES.map((m) => (
            <Menu.Item
              key={m.value}
              data-synthesis-mode={m.value}
              onSelect={() => updateSynthesis({ mode: m.value })}
              className="flex cursor-default items-start gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[highlighted]:bg-white/[0.06]"
            >
              <Check className={cn("mt-[2px] h-3 w-3 shrink-0", r.mode === m.value ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0">
                <span className="block font-medium">{m.label}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{m.hint}</span>
              </span>
            </Menu.Item>
          ))}
          <Menu.Separator className="my-1 h-px bg-white/[0.08]" />
          <Menu.CheckboxItem
            checked={r.autoSend}
            disabled={!actif}
            data-synthesis-autosend
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => updateSynthesis({ autoSend: v === true })}
            className="flex cursor-default items-start gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.06]"
          >
            <Check className={cn("mt-[2px] h-3 w-3 shrink-0", r.autoSend ? "opacity-100" : "opacity-0")} />
            <span className="min-w-0">
              <span className="block font-medium">Send automatically</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                The rewritten request goes straight to the agent. Off: it comes back in the box for you to read, and Enter
                sends it.
              </span>
            </span>
          </Menu.CheckboxItem>
          <Menu.Item
            disabled={!actif || !canRewrite || busy}
            onSelect={onRewriteNow}
            data-synthesis-now
            className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 text-[12px] outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.06]"
          >
            <Wand2 className="h-3 w-3 shrink-0" />
            Rewrite the box now
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
