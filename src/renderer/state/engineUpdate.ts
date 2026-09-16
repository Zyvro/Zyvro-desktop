import type { UpdateState } from "../../preload"

// The engine update state arrives from the main process as IPC events, which is
// a subscription, and the project bans useEffect for exactly this. The listener
// is registered once at import time: there is one main process and one stream,
// so there is nothing to tear down until the window itself goes away.

const IDLE: UpdateState = { status: "idle" }

let state: UpdateState = IDLE
const listeners = new Set<() => void>()

function commit(next: UpdateState): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// getSnapshot returns the stored reference, never a fresh object. Building one
// here would hand React a new value on every call and spin it forever.
export function getSnapshot(): UpdateState {
  return state
}

window.zyvro.engineUpdate.onState(commit)

// The main process may already have checked before this window finished
// loading, so the current state is pulled once rather than waited for.
void window.zyvro.engineUpdate.state().then(commit)

export async function installUpdate(): Promise<void> {
  commit(await window.zyvro.engineUpdate.install())
}

export async function dismissUpdate(): Promise<void> {
  commit(await window.zyvro.engineUpdate.dismiss())
}

export async function checkForUpdate(): Promise<void> {
  commit(await window.zyvro.engineUpdate.check())
}
