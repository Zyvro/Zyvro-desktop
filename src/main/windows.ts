import { BrowserWindow } from "electron"

// Les fenêtres de Studio, et les autres.
//
// L'icône de capture ouvre ses propres fenêtres — la sélection, le cadre d'un
// enregistrement, le résultat. Ce ne sont pas des fenêtres de projet, et tout
// ce qui parcourt les fenêtres de l'app doit les ignorer. Une surtout : le
// serveur de captures de l'agent (`shots.ts`) photographie « les fenêtres de
// l'application » ; s'il voyait la fenêtre de résultat, il donnerait à un
// agent l'écran de la personne, exactement ce qu'il s'interdit de faire.

const capture = new WeakSet<BrowserWindow>()

export function markCaptureWindow(win: BrowserWindow): void {
  capture.add(win)
}

export function isCaptureWindow(win: BrowserWindow): boolean {
  return capture.has(win)
}

/** Les fenêtres de Studio ouvertes, sans celles de la capture. */
export function studioWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !capture.has(w))
}
