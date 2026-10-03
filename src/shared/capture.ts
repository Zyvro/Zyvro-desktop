// La capture d'écran de la barre de menus : ce qui se calcule sans Electron.
//
// Les réglages et ce qu'on accepte d'en relire, la zone choisie ramenée à
// l'écran qui la porte, les noms de fichiers, et la réponse du serveur. Pur,
// pour `scripts/check-capture.mjs`.

export type CaptureSettings = {
  /** Où garder une copie de chaque capture. null : on n'en garde pas. */
  keepDir: string | null
  /** Démarrer avec la session, en arrière-plan, pour que l'icône soit là. */
  launchAtLogin: boolean
  /** La question du démarrage a été posée une fois ; on ne la repose pas. */
  loginAsked: boolean
  /** Sous Windows : on a dit une fois que l'app reste dans la zone de notification. */
  trayNoticeShown: boolean
  shortcutImage: string
  shortcutVideo: string
}

// ⌘⇧2 : à côté des ⌘⇧3, ⌘⇧4 et ⌘⇧5 du système sans en prendre aucun.
export const DEFAULT_CAPTURE: CaptureSettings = {
  keepDir: null,
  // Non par défaut : démarrer avec la session est une chose qu'on choisit.
  launchAtLogin: false,
  loginAsked: false,
  trayNoticeShown: false,
  shortcutImage: "CommandOrControl+Shift+2",
  shortcutVideo: "CommandOrControl+Alt+Shift+2",
}

/** Une minute : la limite du serveur, et celle qu'on annonce. */
export const MAX_RECORDING_MS = 60_000
/** Le GIF : assez pour lire un écran, assez peu pour tenir sous 40 Mo. */
export const GIF_MAX_WIDTH = 640
export const GIF_FPS = 10
/** Le plafond du serveur pour un GIF, moins une marge pour l'en-tête multipart. */
export const GIF_MAX_BYTES = 38 << 20
/** La vidéo : au-delà, l'encodeur logiciel décroche sur un grand écran Retina. */
export const VIDEO_MAX_SIDE = 1920
export const VIDEO_BITS_PER_SECOND = 4_000_000

// Un raccourci : des touches séparées par « + », dont au moins un modificateur.
// Ce n'est pas la grammaire complète d'Electron — `globalShortcut.register`
// reste juge —, c'est ce qui empêche d'enregistrer « A » seul et de voler une
// lettre à toutes les applications de la machine.
const MODIFIERS = new Set([
  "command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta",
])
export function isShortcut(value: unknown): value is string {
  if (typeof value !== "string") return false
  const keys = value.split("+").map((k) => k.trim())
  if (keys.length < 2 || keys.some((k) => k === "") || value.length > 60) return false
  const mods = keys.slice(0, -1)
  return mods.every((k) => MODIFIERS.has(k.toLowerCase())) && !MODIFIERS.has(keys[keys.length - 1].toLowerCase())
}

export function sanitizeCapture(raw: unknown): CaptureSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_CAPTURE
  const dir = typeof r.keepDir === "string" ? r.keepDir.trim() : ""
  return {
    // Un chemin absolu ou rien : un chemin relatif dépendrait du dossier d'où
    // l'app a été lancée.
    keepDir: dir && (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith("\\\\")) ? dir : null,
    launchAtLogin: typeof r.launchAtLogin === "boolean" ? r.launchAtLogin : d.launchAtLogin,
    loginAsked: typeof r.loginAsked === "boolean" ? r.loginAsked : d.loginAsked,
    trayNoticeShown: typeof r.trayNoticeShown === "boolean" ? r.trayNoticeShown : d.trayNoticeShown,
    shortcutImage: isShortcut(r.shortcutImage) ? r.shortcutImage.trim() : d.shortcutImage,
    shortcutVideo: isShortcut(r.shortcutVideo) ? r.shortcutVideo.trim() : d.shortcutVideo,
  }
}

export type Rect = { x: number; y: number; width: number; height: number }

/** Une sélection plus petite que ça est un clic, pas une zone. */
export const MIN_SELECTION = 8

// selectionRect : le rectangle tracé à la souris, dans les deux sens, borné à
// l'écran où il a commencé. null si c'est un clic.
export function selectionRect(
  from: { x: number; y: number },
  to: { x: number; y: number },
  screen: { width: number; height: number }
): Rect | null {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v))
  const x1 = clamp(Math.min(from.x, to.x), screen.width)
  const y1 = clamp(Math.min(from.y, to.y), screen.height)
  const x2 = clamp(Math.max(from.x, to.x), screen.width)
  const y2 = clamp(Math.max(from.y, to.y), screen.height)
  const rect = { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) }
  return rect.width < MIN_SELECTION || rect.height < MIN_SELECTION ? null : rect
}

// pixelRect : la zone, choisie en points, dans les pixels d'une image de
// l'écran entier. Le rapport se lit sur l'image plutôt que sur le facteur
// d'échelle annoncé : une miniature de `desktopCapturer` ou une piste vidéo
// peut être rendue plus petite que l'écran, et c'est sa taille qui compte.
export function pixelRect(rect: Rect, screen: { width: number; height: number }, image: { width: number; height: number }): Rect {
  const sx = image.width / screen.width
  const sy = image.height / screen.height
  const x = Math.max(0, Math.round(rect.x * sx))
  const y = Math.max(0, Math.round(rect.y * sy))
  return {
    x,
    y,
    width: Math.max(1, Math.min(image.width - x, Math.round(rect.width * sx))),
    height: Math.max(1, Math.min(image.height - y, Math.round(rect.height * sy))),
  }
}

// fitWithin : la taille de sortie, réduite pour que le plus grand côté tienne,
// et paire — VP8 et VP9 travaillent par blocs de deux pixels, et une largeur
// impaire se voit comme une colonne verte au bord de la vidéo.
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const even = (v: number) => Math.max(2, Math.floor((v * scale) / 2) * 2)
  return { width: even(width), height: even(height) }
}

export function gifSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, GIF_MAX_WIDTH / width)
  return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)) }
}

// captureName : l'heure, dans un nom qu'on peut trier. Un nom fixe écraserait
// la capture précédente.
export function captureName(extension: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `zyvro-capture-${stamp}.${extension}`
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export type Published = {
  /** Le lien à envoyer : l'image, ou la vidéo. */
  url: string
  /** Pour un enregistrement : le GIF, en téléchargement. */
  gifUrl: string | null
  expiresAt: string
}

// parsePublished : la réponse de `POST /api/shots`. Un lien qui ne serait pas
// http(s) n'est pas un lien qu'on met dans le presse-papier de quelqu'un.
export function parsePublished(answer: unknown): Published {
  const a = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>
  const link = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : null)
  const url = link(a.url)
  if (!url) throw new Error("The server accepted the capture but returned no link.")
  const expires = typeof a.expires_at === "string" && !Number.isNaN(Date.parse(a.expires_at)) ? a.expires_at : ""
  return { url, gifUrl: link(a.gif_url), expiresAt: expires }
}
