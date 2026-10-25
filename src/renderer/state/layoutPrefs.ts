// Où se rangent les grandes pièces de la fenêtre : la barre des fichiers
// (explorateur, recherche, git) à gauche ou à droite, et les projets ouverts
// en onglets en haut ou en panneau à gauche ou à droite. Une préférence de la
// personne devant cet écran, gardée dans le stockage de la fenêtre comme la
// place du Shell (shellDock).

export type Side = "left" | "right"
export type ProjectsAt = "top" | Side

/**
 * La barre de l'agent (plugins, logo du projet) : collée au Shell, ou au bord
 * de la fenêtre. Collée par défaut — avec les fichiers à droite, elle se
 * retrouvait sinon séparée du Shell par toute la barre des fichiers.
 */
export type RailAt = "shell" | "edge"

export type LayoutPrefs = { sidebar: Side; projects: ProjectsAt; projectsWidth: number; rail: RailAt }

const KEY = "zyvro.layout"
const DEFAULTS: LayoutPrefs = { sidebar: "left", projects: "top", projectsWidth: 240, rail: "shell" }

export function sanitizeLayout(raw: unknown): LayoutPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof LayoutPrefs, unknown>>
  const sidebar: Side = r.sidebar === "right" ? "right" : "left"
  const projects: ProjectsAt = r.projects === "left" || r.projects === "right" ? r.projects : "top"
  const width = typeof r.projectsWidth === "number" && Number.isFinite(r.projectsWidth) ? r.projectsWidth : DEFAULTS.projectsWidth
  const rail: RailAt = r.rail === "edge" ? "edge" : "shell"
  return { sidebar, projects, projectsWidth: Math.min(480, Math.max(180, Math.round(width))), rail }
}

function read(): LayoutPrefs {
  try {
    const text = window.localStorage.getItem(KEY)
    return sanitizeLayout(text ? JSON.parse(text) : null)
  } catch {
    return DEFAULTS
  }
}

let prefs: LayoutPrefs = read()
const listeners = new Set<() => void>()

export function layoutPrefs(): LayoutPrefs {
  return prefs
}

export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLayout(change: Partial<LayoutPrefs>): void {
  prefs = sanitizeLayout({ ...prefs, ...change })
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Se souvenir est un confort.
  }
  for (const listener of listeners) listener()
}
