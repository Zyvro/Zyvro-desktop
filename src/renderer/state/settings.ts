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
  versLeFichier()
}

// ---------- le fichier ----------
//
// Les mêmes réglages, aussi dans `<dossier de l'app>/settings.json` : un
// fichier qu'on retrouve, qu'on exporte, qu'on peut éditer à la main. Le
// stockage de la fenêtre répond tout de suite au démarrage ; le fichier, relu
// juste après, gagne s'il dit autre chose.

function pont(): Window["zyvro"]["settingsFile"] | null {
  return typeof window !== "undefined" && window.zyvro?.settingsFile ? window.zyvro.settingsFile : null
}

let ecriture: ReturnType<typeof setTimeout> | null = null
function versLeFichier(): void {
  const fichier = pont()
  if (!fichier) return
  // Une rafale de changements — un curseur qu'on fait glisser — n'écrit qu'une fois.
  if (ecriture) clearTimeout(ecriture)
  ecriture = setTimeout(() => {
    ecriture = null
    void fichier.write(courant).catch(() => {})
  }, 300)
}

/** Remplacer tous les réglages par ceux d'un fichier importé, nettoyés. */
export function replaceSettings(raw: unknown): EditorSettings {
  updateSettings(sanitizeSettings(raw))
  return courant
}

void (async () => {
  const fichier = pont()
  if (!fichier) return
  const lu = await fichier.read().catch(() => null)
  if (!lu) return
  if (lu.settings === null) {
    // Pas encore de fichier : on le crée avec ce que la fenêtre savait.
    void fichier.write(courant).catch(() => {})
    return
  }
  const depuisLeFichier = sanitizeSettings(lu.settings)
  if (JSON.stringify(depuisLeFichier) !== JSON.stringify(courant)) replaceSettings(depuisLeFichier)
})().finally(reprendreLAncien)

// Avant les plugins (shared/plugins), « Show token usage » avait sa clé à lui
// dans le stockage de la fenêtre. Repris une fois, APRÈS la relecture du
// fichier : avant, le fichier — écrit sans plugins, donc « tout allumé » —
// écraserait le « off » qu'on vient de reprendre, et la clé effacée, le choix
// serait perdu.
function reprendreLAncien(): void {
  if (typeof window === "undefined") return
  try {
    const ancien = window.localStorage.getItem("zyvro.usage.shown")
    if (ancien === null) return
    window.localStorage.removeItem("zyvro.usage.shown")
    if (ancien === "off") {
      updateSettings({ agent: { ...courant.agent, plugins: { ...courant.agent.plugins, usage: false } } })
    }
  } catch {
    // Sans stockage, il n'y a rien à reprendre.
  }
}

export function resetSettings(): void {
  updateSettings(DEFAULT_SETTINGS)
}
