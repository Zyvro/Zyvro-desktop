// Où le logo du projet se range dans la barre latérale droite.
//
// En bas par défaut — c'est là qu'il était, sous la boîte de l'agent —, et
// déplaçable en haut depuis son menu. Une préférence de la personne devant cet
// écran, gardée dans le stockage de la fenêtre comme la disposition.

export type LogoPosition = "top" | "bottom"

const KEY = "zyvro.rail.logo"

function read(): LogoPosition {
  try {
    return window.localStorage.getItem(KEY) === "top" ? "top" : "bottom"
  } catch {
    return "bottom"
  }
}

let position: LogoPosition = read()
const listeners = new Set<() => void>()

export function logoPosition(): LogoPosition {
  return position
}

export function subscribeLogoPosition(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLogoPosition(next: LogoPosition): void {
  position = next === "top" ? "top" : "bottom"
  try {
    window.localStorage.setItem(KEY, position)
  } catch {
    // Se souvenir est un confort.
  }
  for (const listener of listeners) listener()
}
