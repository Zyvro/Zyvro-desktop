import { getSettings } from "~/state/settings"

// Ce qu'un agent lancé dans un shell reçoit de la fenêtre, au moment où on le
// lance : les réglages des agents (plugins allumés, skills…). Le reste, le
// principal le sait lui-même.
export async function agentContext(): Promise<{
  workflows: { id: string; name: string; description?: string }[]
  agentSettings: ReturnType<typeof getSettings>["agent"]
}> {
  return { workflows: [], agentSettings: getSettings().agent }
}
