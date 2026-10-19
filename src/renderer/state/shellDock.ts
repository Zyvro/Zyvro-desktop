// Où se range le panneau Shell + Agents en mode Dev : à droite du code, ou en
// dessous. Une préférence de la personne devant cet écran (stockage de la
// fenêtre), comme la disposition des autres panneaux.
//
// À droite par défaut : c'est la place qu'avait la colonne de l'agent. Le mode
// IA n'a pas le choix — le Shell y prend toute la fenêtre.

export type ShellDock = "right" | "bottom"

const KEY = "zyvro.shell.dock"

function read(): ShellDock {
  try {
    return window.localStorage.getItem(KEY) === "bottom" ? "bottom" : "right"
  } catch {
    return "right"
  }
}

let dock: ShellDock = read()
const listeners = new Set<() => void>()

export function shellDock(): ShellDock {
  return dock
}

export function subscribeShellDock(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setShellDock(next: ShellDock): void {
  dock = next === "bottom" ? "bottom" : "right"
  try {
    window.localStorage.setItem(KEY, dock)
  } catch {
    // Se souvenir est un confort.
  }
  for (const listener of listeners) listener()
}

export function toggleShellDock(): void {
  setShellDock(dock === "right" ? "bottom" : "right")
}
