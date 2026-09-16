// Electron has no window.prompt: calling it throws "prompt() is not supported".
// Anything that needs a name from the user therefore needs a real dialog, and
// the menu needs to open one from outside the React tree. So the request lives
// in a tiny module store: askName() returns a promise, the component renders
// whatever is pending, and resolving it settles that promise.

export type NameRequest = {
  title: string
  label: string
  initial: string
  confirmLabel: string
}

type Pending = NameRequest & { resolve: (value: string | null) => void }

let pending: Pending | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// getSnapshot must return a cached reference. Building a fresh object here
// would hand React a new value on every call and spin it forever.
export function getPending(): Pending | null {
  return pending
}

export function askName(request: Partial<NameRequest> & { title: string }): Promise<string | null> {
  // A second request while one is open would strand the first promise, so the
  // one already on screen is cancelled rather than silently replaced.
  pending?.resolve(null)
  return new Promise((resolve) => {
    pending = {
      label: "Name",
      initial: "",
      confirmLabel: "Create",
      ...request,
      resolve,
    }
    emit()
  })
}

export function settle(value: string | null): void {
  const current = pending
  pending = null
  emit()
  current?.resolve(value)
}
