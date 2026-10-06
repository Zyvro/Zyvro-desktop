import { MemoryButton, refreshMemory } from "~/panels/MemoryButton"
import { memoryPrompt } from "../../shared/memory"
import type { AgentPlugin } from "./types"

// La mémoire du projet (ZYVRO.md). L'autre moitié est dans le principal : c'est
// lui qui la relit et la met dans le préambule de chaque tour, et seulement si
// ce plugin est allumé (main/ipc.ts, `agent:send`).
export const memoryPlugin: AgentPlugin = {
  id: "memory",
  Rail: ({ ctx }) =>
    ctx.project ? (
      <MemoryButton
        project={ctx.project}
        permission={ctx.permission}
        onRunAgent={(exists) =>
          ctx.actions.runInThread(exists ? "Update project memory" : "Create project memory", memoryPrompt(exists))
        }
      />
    ) : null,
  // L'agent a peut-être réécrit la mémoire pendant ce tour.
  turnEnded: () => refreshMemory(),
}
