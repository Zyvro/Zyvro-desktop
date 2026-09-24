// Les réglages de l'éditeur, et ce qu'on accepte d'y lire.
//
// Ils étaient écrits en dur dans `CodeEditor.tsx` : treize pixels, deux
// espaces, pas de retour à la ligne, pas de minimap. Ce qui convient à un écran
// ne convient pas à un autre, et un éditeur dont on ne peut pas grossir le
// texte est un éditeur qu'on quitte.
//
// Ce module dit les valeurs par défaut et nettoie ce qu'on relit du stockage :
// une valeur d'une ancienne version, tapée à la main ou abîmée ne doit pas
// donner un éditeur en police 0 ou en tabulation 400. Pur, pour
// `scripts/check-settings.mjs`.

export type AutoSave = "off" | "afterDelay" | "onFocusChange"

export type EditorSettings = {
  fontSize: number
  tabSize: number
  insertSpaces: boolean
  /** Laisser Monaco deviner l'indentation d'un fichier ouvert, comme VS Code. */
  detectIndentation: boolean
  wordWrap: "off" | "on"
  minimap: boolean
  lineNumbers: "on" | "off" | "relative"
  renderWhitespace: "none" | "selection" | "boundary" | "all"
  autoSave: AutoSave
  /** Millisecondes, pour `afterDelay`. */
  autoSaveDelay: number
  /** Demander à GitHub, au démarrage puis de temps en temps, s'il y a mieux. */
  checkForUpdates: boolean
}

export const DEFAULT_SETTINGS: EditorSettings = {
  fontSize: 13,
  tabSize: 2,
  insertSpaces: true,
  detectIndentation: true,
  wordWrap: "off",
  minimap: false,
  lineNumbers: "on",
  renderWhitespace: "selection",
  // Éteinte, comme dans VS Code : écrire sur le disque sans qu'on le demande
  // est une chose qu'on choisit, pas qu'on découvre.
  autoSave: "off",
  autoSaveDelay: 1000,
  checkForUpdates: true,
}

function entre(value: unknown, min: number, max: number, defaut: number): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return defaut
  return Math.min(max, Math.max(min, Math.round(n)))
}

function parmi<T extends string>(value: unknown, choix: readonly T[], defaut: T): T {
  return choix.includes(value as T) ? (value as T) : defaut
}

function booleen(value: unknown, defaut: boolean): boolean {
  return typeof value === "boolean" ? value : defaut
}

export function sanitizeSettings(raw: unknown): EditorSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  return {
    fontSize: entre(r.fontSize, 8, 32, d.fontSize),
    tabSize: entre(r.tabSize, 1, 8, d.tabSize),
    insertSpaces: booleen(r.insertSpaces, d.insertSpaces),
    detectIndentation: booleen(r.detectIndentation, d.detectIndentation),
    wordWrap: parmi(r.wordWrap, ["off", "on"] as const, d.wordWrap),
    minimap: booleen(r.minimap, d.minimap),
    lineNumbers: parmi(r.lineNumbers, ["on", "off", "relative"] as const, d.lineNumbers),
    renderWhitespace: parmi(r.renderWhitespace, ["none", "selection", "boundary", "all"] as const, d.renderWhitespace),
    autoSave: parmi(r.autoSave, ["off", "afterDelay", "onFocusChange"] as const, d.autoSave),
    autoSaveDelay: entre(r.autoSaveDelay, 200, 60_000, d.autoSaveDelay),
    checkForUpdates: booleen(r.checkForUpdates, d.checkForUpdates),
  }
}

// lineHeight : la hauteur de ligne qui suit la police. Écrite en dur à 20, elle
// faisait se chevaucher les lignes dès 16 pixels.
export function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.54)
}
