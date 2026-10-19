import { api } from "@/lib/api"
import { queryClient } from "~/lib/queryClient"
import { getSettings } from "~/state/settings"

// Ce qu'un agent lancé dans un shell sait du projet, au moment où on le lance.
//
// Les workflows viennent du démon, que la fenêtre a déjà interrogé : le
// principal ne les redemande pas. Une liste qui ne vient pas n'empêche rien —
// l'agent ne connaîtra simplement pas les workflows par leur nom, comme pour un
// tour du panneau.
const WORKFLOWS_KEY = ["local", "workflows"] as const

export async function agentContext(): Promise<{
  workflows: { id: string; name: string; description?: string }[]
  agentSettings: ReturnType<typeof getSettings>["agent"]
}> {
  let workflows: { id: string; name: string; description?: string }[] = []
  try {
    const listed = await queryClient.fetchQuery({ queryKey: WORKFLOWS_KEY, queryFn: () => api.listWorkflows() })
    workflows = listed.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description || undefined,
    }))
  } catch {
    workflows = []
  }
  return { workflows, agentSettings: getSettings().agent }
}
