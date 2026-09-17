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
  // « confirm » n'a pas de champ à remplir : une seule question et deux
  // réponses. Le même magasin les porte, parce que ce qui est difficile ici
  // n'est pas le formulaire, c'est de pouvoir demander depuis n'importe où —
  // un menu, une ligne de liste, un raccourci.
  kind: "name" | "confirm"
  // Le bouton qui détruit est rouge. Une suppression qui a l'air d'une
  // création est une suppression qu'on accepte sans lire.
  danger: boolean
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
      kind: "name",
      danger: false,
      ...request,
      resolve,
    }
    emit()
  })
}

// askConfirm : la question avant ce qui ne se rattrape pas.
export function askConfirm(request: {
  title: string
  label: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  pending?.resolve(null)
  return new Promise((resolve) => {
    pending = {
      title: request.title,
      label: request.label,
      initial: "",
      confirmLabel: request.confirmLabel ?? "Delete",
      kind: "confirm",
      danger: request.danger !== false,
      resolve: (value) => resolve(value !== null),
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
