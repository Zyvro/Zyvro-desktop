import { BugButton } from "~/panels/BugReportDialog"
import type { AgentPlugin } from "./types"

// Signaler un bug, là où il arrive : l'état complet part avec la description.
// Jamais grisé — c'est justement quand le panneau est bloqué qu'on en a besoin.
export const bugReportPlugin: AgentPlugin = {
  id: "bugReport",
  Rail: ({ ctx }) => <BugButton snapshot={ctx.actions.snapshot} />,
}
