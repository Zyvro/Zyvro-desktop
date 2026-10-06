export type AgentAction = "focus" | "new" | "sessions" | "login"
let pending: AgentAction | null = null
let version = 0
const listeners = new Set<() => void>()

// Keep requests until AgentPanel mounts; the menu can open a hidden panel.
export function requestAgentAction(action: AgentAction): void {
  pending = action
  version++
  for (const listener of listeners) listener()
}
export const agentActionToken = (): number => version
export function subscribeAgentActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function takeAgentAction(): AgentAction | null {
  const action = pending
  pending = null
  return action
}
