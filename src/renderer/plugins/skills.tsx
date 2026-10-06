import { useSyncExternalStore } from "react"
import { SkillsButton } from "~/panels/SkillsButton"
import { getSettings, subscribeSettings } from "~/state/settings"
import type { AgentPlugin } from "./types"

// Les skills avancés. Le catalogue n'est envoyé que si ce plugin est allumé ET
// que la conversation l'a activé (le bouton) : les deux se vérifient dans le
// principal, au lancement du tour.
export const skillsPlugin: AgentPlugin = {
  id: "skills",
  Rail: SkillsRail,
}

function SkillsRail({ ctx }: Parameters<NonNullable<AgentPlugin["Rail"]>>[0]): JSX.Element {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  return (
    <SkillsButton
      kind={ctx.kind}
      active={ctx.thread.advancedSkills}
      settings={settings.agent}
      disabled={ctx.disabled || ctx.thread.busy || ctx.thread.queued > 0}
      onChange={ctx.actions.setAdvancedSkills}
    />
  )
}
