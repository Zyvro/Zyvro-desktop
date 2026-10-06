import type { AgentPlugin } from "./types"

// Les deux plugins qui vivent dans les réponses plutôt que dans la barre : la
// ligne de jetons (lue par `usageShown`, lib/usage) et le bouton de lecture à
// voix haute (SpeakButton, AgentPanel). Rien à fournir à l'hôte : c'est leur
// interrupteur qui compte.
export const usagePlugin: AgentPlugin = { id: "usage" }
export const speechPlugin: AgentPlugin = { id: "speech" }
