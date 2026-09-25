import { app, type BrowserWindow } from "electron"
import fs from "node:fs"
import path from "node:path"

// Le zoom de la fenêtre, retenu d'une session à l'autre, comme
// `window.zoomLevel` de VS Code.
//
// Les rôles de menu d'Electron (zoomIn, zoomOut, resetZoom) zooment mais
// n'enregistrent rien : relancer l'application ramenait tout à 100 %. Les
// entrées du menu passent donc par ici, et ⌘-molette aussi (`zoom-changed`).

// Le pas des rôles d'Electron, et les bornes au-delà desquelles l'interface ne
// se lit plus : de 50 % à 300 % environ (1,2 ^ niveau).
export const ZOOM_STEP = 0.5
export const ZOOM_MIN = -3
export const ZOOM_MAX = 6

/** Le niveau suivant, borné et arrondi au pas. Pur. */
export function nextZoom(level: number, direction: 1 | -1 | 0): number {
  if (direction === 0) return 0
  const n = Math.round((level + direction * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n))
}

/** Un niveau lu sur le disque : un nombre dans les bornes, sinon 0. Pur. */
export function sanitizeZoom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) : 0
}

function fichier(): string {
  return path.join(app.getPath("userData"), "window-zoom.json")
}

export function savedZoom(): number {
  try {
    return sanitizeZoom(JSON.parse(fs.readFileSync(fichier(), "utf8")).zoomLevel)
  } catch {
    return 0
  }
}

function retenir(level: number): void {
  try {
    fs.writeFileSync(fichier(), JSON.stringify({ zoomLevel: level }))
  } catch {
    // Perdre le zoom est cosmétique.
  }
}

export function setZoom(win: BrowserWindow, level: number): void {
  const z = sanitizeZoom(level)
  win.webContents.setZoomLevel(z)
  retenir(z)
}

export function zoomBy(win: BrowserWindow, direction: 1 | -1 | 0): void {
  setZoom(win, nextZoom(win.webContents.getZoomLevel(), direction))
}

// Une fenêtre neuve reprend le zoom retenu, à chaque chargement (un
// rechargement le remettrait sinon à 100 %), et ⌘-molette l'enregistre.
export function trackZoom(win: BrowserWindow): void {
  win.webContents.on("did-finish-load", () => win.webContents.setZoomLevel(savedZoom()))
  win.webContents.on("zoom-changed", (_event, sens) => zoomBy(win, sens === "in" ? 1 : -1))
}
