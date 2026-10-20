import fs from "node:fs"
import path from "node:path"
import { MIN_WINDOW, TITLEBAR_HEIGHT } from "../shared/windowChrome"

// La taille et la place de la fenêtre, retenues d'un lancement à l'autre.
//
// Sans elles, chaque lancement rouvre une fenêtre 1440×900 au même endroit : on
// la redimensionne, on la déplace, on la ferme, et tout est à refaire. Mais le
// plus dangereux n'est pas de l'oublier, c'est de s'en souvenir trop bien : un
// écran débranché, une résolution changée, et la fenêtre se rouvre HORS de tout
// écran, introuvable, sans barre de titre où la saisir. C'est le classique de ce
// genre de code, et `fit` est ce qui l'empêche : ce qu'on relit est toujours
// ramené sur un écran qui existe.
//
// Pur, hormis `load` et `save`, pour `scripts/check-window.mjs`.

export type Rect = { x: number; y: number; width: number; height: number }
export type WindowState = Rect & { maximized: boolean; fullScreen: boolean }
export type Display = { workArea: Rect }

export const DEFAULT_SIZE = { width: 1440, height: 900 } as const

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null
}

/** Lire ce qu'on a écrit, ou rien : un fichier abîmé ne doit jamais empêcher d'ouvrir une fenêtre. */
export function parseState(raw: unknown): Partial<WindowState> | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const width = num(r.width)
  const height = num(r.height)
  if (width === null || height === null || width <= 0 || height <= 0) return null
  return {
    x: num(r.x) ?? undefined,
    y: num(r.y) ?? undefined,
    width,
    height,
    maximized: r.maximized === true,
    fullScreen: r.fullScreen === true,
  }
}

function area(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Ramener la fenêtre sur un écran qui existe.
 *
 * - La taille tient dans la zone utile de l'écran où elle se trouve, et n'est jamais
 *   sous le minimum.
 * - Sa barre de titre doit rester saisissable : au moins une bande de 120 × 44 pixels de
 *   la barre dans un écran. Sinon, ou sans position retenue, la fenêtre se centre sur
 *   l'écran principal (le premier de la liste).
 */
export function fit(saved: Partial<WindowState> | null, displays: Display[], cascade = 0): WindowState {
  const primary = displays[0]?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }
  const width0 = saved?.width ?? DEFAULT_SIZE.width
  const height0 = saved?.height ?? DEFAULT_SIZE.height

  // L'écran qui contient le plus de la fenêtre retenue, sinon le principal.
  let home = primary
  if (saved?.x !== undefined && saved.y !== undefined) {
    const rect = { x: saved.x, y: saved.y, width: width0, height: height0 }
    let best = 0
    for (const d of displays) {
      const a = area(rect, d.workArea)
      if (a > best) {
        best = a
        home = d.workArea
      }
    }
  }

  const width = Math.max(Math.min(MIN_WINDOW.width, home.width), Math.min(width0, home.width))
  const height = Math.max(Math.min(MIN_WINDOW.height, home.height), Math.min(height0, home.height))

  const centered = (): Rect => ({
    width,
    height,
    x: Math.round(home.x + (home.width - width) / 2) + cascade,
    y: Math.round(home.y + (home.height - height) / 2) + cascade,
  })

  let rect: Rect
  if (saved?.x === undefined || saved.y === undefined) {
    rect = centered()
  } else {
    rect = { x: saved.x + cascade, y: saved.y + cascade, width, height }
    const strip = { x: rect.x, y: rect.y, width: Math.min(120, width), height: TITLEBAR_HEIGHT }
    const grabbable = displays.some((d) => area(strip, d.workArea) >= strip.width * strip.height * 0.75)
    if (!grabbable) rect = centered()
  }
  return { ...rect, maximized: saved?.maximized === true, fullScreen: saved?.fullScreen === true }
}

export function load(file: string): Partial<WindowState> | null {
  try {
    return parseState(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch {
    return null
  }
}

/** Écrit à côté puis renommé : une coupure au milieu laisserait un fichier tronqué. */
export function save(file: string, state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.partial`
    fs.writeFileSync(temp, JSON.stringify(state), "utf8")
    fs.renameSync(temp, file)
  } catch {
    // Retenir la fenêtre est un confort : un disque plein ne doit pas la fermer.
  }
}
