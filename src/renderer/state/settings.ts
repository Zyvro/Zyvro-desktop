// Les réglages de l'éditeur, gardés sur cette machine.
//
// Dans le stockage de la fenêtre, comme le mode Dev/AI : ce sont des
// préférences de la personne devant cet écran, pas du projet — une taille de
// police ne se commite pas. Relus par `sanitizeSettings`, qui refuse ce qui
// n'a pas de sens.

import { DEFAULT_SETTINGS, sanitizeSettings, type EditorSettings } from "../../shared/settings"

const KEY = "zyvro.editorSettings"

function lire(): EditorSettings {
  try {
    const brut = localStorage.getItem(KEY)
    return brut ? sanitizeSettings(JSON.parse(brut)) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

let courant: EditorSettings = lire()
const listeners = new Set<() => void>()

export function getSettings(): EditorSettings {
  return courant
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function updateSettings(patch: Partial<EditorSettings>): void {
  courant = sanitizeSettings({ ...courant, ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(courant))
  } catch {
    // Sans stockage, le réglage vaut pour cette session : mieux que rien.
  }
  for (const listener of listeners) listener()
}

export function resetSettings(): void {
  updateSettings(DEFAULT_SETTINGS)
}
