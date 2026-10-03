import { useQuery } from "@tanstack/react-query"
import type { AgentKind } from "../../shared/harness"
import { askInstall } from "~/state/persistent"
import { useWorkspace } from "~/state/workspace"

// Quels harnais sont sur cette machine.
//
// Sondé seulement tant qu'il en manque un : c'est le moment où la réponse
// change — un `npm install -g` qui tourne dans le terminal, lancé d'ici ou
// d'ailleurs — et une fois tout installé il n'y a plus rien à apprendre.
export function useHarnessesInstalled() {
  return useQuery({
    queryKey: ["agent", "installed"],
    queryFn: () => window.zyvro.agent.installed(),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const data = query.state.data
      return data && Object.values(data.harnesses).every(Boolean) ? false : 4000
    },
  })
}

// installHarness ouvre le terminal sur un onglet qui installe ce harnais.
export function installHarness(kind: AgentKind): void {
  useWorkspace.getState().setPanel("terminal", true)
  askInstall(kind)
}

// Où l'on prend npm quand il n'y est pas : Node.js l'apporte.
export const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download"
