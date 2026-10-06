import { useSyncExternalStore } from "react"
import { SettingRow, Toggle } from "~/panels/SettingsAgents"
import { SynthesisPicker } from "~/panels/SynthesisPicker"
import { subscribeSynthesis, synthesisSettings, updateSynthesis } from "~/state/synthesis"
import { SYNTHESIS_MODES, type SynthesisMode } from "../../shared/synthesize"
import type { AgentPlugin } from "./types"

// L'auto-synthèse (shared/synthesize). Le panneau lit le mode par
// `activeSynthesis()` (state/synthesis), qui répond « off » quand ce plugin est
// éteint : la demande part alors telle qu'on l'a tapée.
export const synthesisPlugin: AgentPlugin = {
  id: "synthesis",
  Rail: ({ ctx }) => (
    <SynthesisPicker
      disabled={ctx.disabled}
      busy={ctx.rewriting}
      canRewrite={ctx.draft.trim() !== ""}
      onRewriteNow={ctx.actions.rewriteNow}
    />
  ),
  Settings: SynthesisSettings,
}

function SynthesisSettings(): JSX.Element {
  const synthesis = useSyncExternalStore(subscribeSynthesis, synthesisSettings)
  return <>
    <SettingRow title="Rewrite prompts" hint="Automatically rewrite prompts before sending. Rewriting uses your model account.">
      <select aria-label="Rewrite prompts" value={synthesis.mode} onChange={(e) => updateSynthesis({ mode: e.target.value as SynthesisMode })} className="max-w-full rounded-md border border-white/10 bg-background p-2 text-xs">
        {SYNTHESIS_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
      </select>
    </SettingRow>
    <SettingRow title="Send rewritten prompts automatically" hint="When off, the rewritten prompt returns to the composer for you to review.">
      <Toggle label="Send rewritten prompts automatically" checked={synthesis.autoSend} disabled={synthesis.mode === "off"} onChange={(autoSend) => updateSynthesis({ autoSend })} />
    </SettingRow>
  </>
}
