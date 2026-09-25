// Le réglage de l'auto-synthèse (shared/synthesize) : le mode, et si la
// demande réécrite part d'elle-même ou revient d'abord dans la boîte.
// Gardé sur ce poste, comme les réglages de l'éditeur.

import { isSynthesisMode, type SynthesisMode } from "../../shared/synthesize"

export type SynthesisSettings = { mode: SynthesisMode; autoSend: boolean }

const CLE = "zyvro.synthesis"
const listeners = new Set<() => void>()

function lire(): SynthesisSettings {
  try {
    const r = JSON.parse(localStorage.getItem(CLE) ?? "{}") as Partial<SynthesisSettings>
    return { mode: isSynthesisMode(r.mode) ? r.mode : "off", autoSend: r.autoSend === true }
  } catch {
    return { mode: "off", autoSend: false }
  }
}

let courant = lire()
export const synthesisSettings = (): SynthesisSettings => courant
export function subscribeSynthesis(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function updateSynthesis(patch: Partial<SynthesisSettings>): void {
  courant = { ...courant, ...patch }
  try {
    localStorage.setItem(CLE, JSON.stringify(courant))
  } catch {
    // Se souvenir est un confort.
  }
  for (const l of listeners) l()
}
