// La capture d'écran de la barre de menus.
//
// Une icône dans la barre de menus (macOS) ou la zone de notification
// (Windows) : on choisit une zone de l'écran, en image ou en vidéo d'une
// minute au plus, et une petite fenêtre propose de la copier, de la garder ou
// de la publier — un lien public qui dure un jour.
//
// Ce n'est pas un outil de l'agent, et ça doit le rester. `shots.ts` dit en
// tête qu'il ne capture pas l'écran, et c'est voulu : un outil qui lit l'écran
// d'une machine est un outil dont il faut se méfier. Celui-ci ne part que
// d'un geste de la personne — un clic sur l'icône, un raccourci — et aucun
// serveur MCP ne l'atteint. `scripts/check-capture.mjs` y veille.
//
// La sélection : sous macOS, celle du système (`screencapture -i`) pour une
// image — le réticule, Espace pour une fenêtre, Échap pour annuler, tout ce
// que les doigts connaissent déjà. Le système n'a rien d'équivalent qu'on
// puisse piloter pour une vidéo, ni Windows pour quoi que ce soit : là, une
// fenêtre transparente par écran, sur laquelle on trace la zone.

import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  type BrowserWindowConstructorOptions,
  type Display,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { authorized, currentAccount } from "./account"
import { markCaptureWindow } from "./windows"
import {
  DEFAULT_CAPTURE,
  MAX_RECORDING_MS,
  captureName,
  formatElapsed,
  parsePublished,
  pixelRect,
  sanitizeCapture,
  type CaptureSettings,
  type Published,
  type Rect,
} from "../shared/capture"

type Deps = {
  /** Montrer une fenêtre de Studio, en ouvrir une s'il n'y en a plus. */
  openStudio: () => BrowserWindow
}

type Last =
  | { kind: "image"; png: Buffer; width: number; height: number; kept: string | null; published: Published | null }
  | {
      kind: "video"
      webm: Buffer
      gif: Buffer | null
      gifTooLarge: boolean
      width: number
      height: number
      ms: number
      kept: string | null
      published: Published | null
    }

const isMac = process.platform === "darwin"
const RECORDER_PARTITION = "zyvro-capture-recorder"

let deps: Deps | null = null
let settings: CaptureSettings = DEFAULT_CAPTURE
let tray: Tray | null = null
let shortcutErrors: { image: string | null; video: string | null } = { image: null, video: null }

// Une chose à la fois : une sélection, un enregistrement, ou rien.
let busy: "idle" | "selecting" | "recording" = "idle"
let last: Last | null = null

let overlays = new Map<number, { win: BrowserWindow; display: Display }>()
let overlayMode: "image" | "video" = "image"
/** La zone de l'enregistrement en cours, pour poser le cadre autour. */
let lastSelection: { display: Display; rect: Rect } | null = null
let selectionDone: ((chosen: { display: Display; rect: Rect } | null) => void) | null = null

let recorder: BrowserWindow | null = null
let recorderConfig: { rect: Rect; screen: { width: number; height: number }; maxMs: number } | null = null
let recordingStarted = 0
let recordingTimer: NodeJS.Timeout | null = null
let recordingDone: ((result: { ok: true; payload: unknown } | { ok: false; message: string }) => void) | null = null
let border: BrowserWindow | null = null
let pill: BrowserWindow | null = null
let result: BrowserWindow | null = null

// ---- les réglages ------------------------------------------------------------

function settingsFile(): string {
  return path.join(app.getPath("userData"), "capture.json")
}

function loadSettings(): CaptureSettings {
  try {
    return sanitizeCapture(JSON.parse(fs.readFileSync(settingsFile(), "utf8")))
  } catch {
    return DEFAULT_CAPTURE
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), "utf8")
  } catch (err) {
    console.error("[capture] réglages non enregistrés:", err)
  }
}

export type CaptureSettingsView = CaptureSettings & {
  shortcutErrors: { image: string | null; video: string | null }
  /** En développement, l'app lancée à la connexion serait Electron nu : on ne le propose pas. */
  loginAvailable: boolean
}

function view(): CaptureSettingsView {
  return { ...settings, shortcutErrors, loginAvailable: app.isPackaged }
}

// Démarrer avec la session, en arrière-plan. Jamais en développement : ce
// serait inscrire le binaire d'Electron, sans application dedans.
function applyLoginItem(): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, args: ["--background"] })
  } catch (err) {
    console.error("[capture] démarrage à la connexion:", err)
  }
}

// launchedInBackground : lancée par la session plutôt que par quelqu'un. Pas
// de fenêtre alors, seulement l'icône — c'est pour elle qu'on démarre.
export function launchedInBackground(): boolean {
  if (process.argv.includes("--background")) return true
  if (!isMac || !app.isPackaged) return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin
  } catch {
    return false
  }
}

// ---- les raccourcis ------------------------------------------------------------

function registerShortcuts(): void {
  globalShortcut.unregisterAll()
  shortcutErrors = { image: null, video: null }
  const take = (accelerator: string, run: () => void): string | null => {
    try {
      return globalShortcut.register(accelerator, run) ? null : `${accelerator} is already used by another application.`
    } catch {
      return `${accelerator} is not a shortcut this system understands.`
    }
  }
  shortcutErrors.image = take(settings.shortcutImage, () => void captureImage())
  if (settings.shortcutVideo === settings.shortcutImage) {
    shortcutErrors.video = "Same shortcut as Capture Area."
  } else {
    shortcutErrors.video = take(settings.shortcutVideo, () => {
      if (busy === "recording") stopRecording()
      else void recordVideo()
    })
  }
}

// ---- l'icône -----------------------------------------------------------------

function trayImage(recording: boolean): Electron.NativeImage {
  // Le dossier des ressources, empaqueté ou non. Dans un paquet, il est dans
  // l'asar, que nativeImage sait lire.
  const dir = path.join(app.getAppPath(), "resources", "tray")
  if (isMac) {
    // « Template » : macOS le teinte lui-même, noir ou blanc selon la barre.
    // Il ne peut pas être rouge ; pendant un enregistrement, la barre montre le
    // temps écoulé à côté de l'icône.
    const image = nativeImage.createFromPath(path.join(dir, "trayTemplate.png"))
    image.setTemplateImage(true)
    return image
  }
  return nativeImage.createFromPath(path.join(dir, recording ? "trayRecording.png" : "tray.png"))
}

function buildTrayMenu(): void {
  if (!tray) return
  const idle = busy === "idle"
  const items: MenuItemConstructorOptions[] = []
  if (busy === "recording") {
    items.push(
      { label: `Stop Recording (${formatElapsed(Date.now() - recordingStarted)})`, click: () => stopRecording() },
      { type: "separator" }
    )
  }
  items.push(
    {
      label: "Capture Area",
      accelerator: shortcutErrors.image ? undefined : settings.shortcutImage,
      registerAccelerator: false,
      enabled: idle,
      click: () => void captureImage(),
    },
    {
      label: "Record Area (up to 1 min)",
      accelerator: shortcutErrors.video ? undefined : settings.shortcutVideo,
      registerAccelerator: false,
      enabled: idle,
      click: () => void recordVideo(),
    },
    { type: "separator" },
    { label: "Open Zyvro Studio", click: () => deps?.openStudio() },
    { label: "Capture Settings…", click: () => openSettings() },
    { type: "separator" },
    { label: "Quit Zyvro Studio", click: () => app.quit() }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function setRecordingLook(recording: boolean): void {
  if (!tray) return
  if (isMac) tray.setTitle(recording ? ` ${formatElapsed(Date.now() - recordingStarted)}` : "")
  else tray.setImage(trayImage(recording))
  tray.setToolTip(recording ? "Zyvro Studio — recording, click to stop" : "Zyvro Studio — capture")
  buildTrayMenu()
}

function openSettings(): void {
  if (!deps) return
  const win = deps.openStudio()
  const send = () => win.webContents.send("menu:open-settings")
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send)
  else send()
}

// ---- les fenêtres de capture ------------------------------------------------

function capturePage(win: BrowserWindow, mode: string): void {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && dev) void win.loadURL(`${dev}/capture.html#${mode}`)
  else void win.loadFile(path.join(__dirname, "../renderer/capture.html"), { hash: mode })
}

function captureWindow(options: BrowserWindowConstructorOptions, mode: string): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Un panneau, sous macOS : il flotte au-dessus des apps en plein écran et
    // n'active pas Studio. Sans ça, cliquer dans la sélection ferait passer la
    // fenêtre de Studio devant l'app qu'on voulait capturer.
    ...(isMac ? { type: "panel" } : {}),
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "../preload/capture.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Pas de sandbox, comme la fenêtre de Studio : les deux ponts partagent
      // du code, que le build range dans un morceau à part chargé par
      // `require`, et un preload sandboxé ne peut charger qu'electron. Le
      // pont ne serait jamais posé. L'isolation du contexte reste, et ces
      // pages ne chargent que leur propre paquet.
      sandbox: false,
      spellcheck: false,
      ...options.webPreferences,
    },
  })
  markCaptureWindow(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    event.preventDefault()
  })
  capturePage(win, mode)
  return win
}

function sentBy(event: IpcMainInvokeEvent, win: BrowserWindow | null): boolean {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

function nearTray(width: number, height: number): Rect {
  const bounds = tray?.getBounds()
  const known = bounds && bounds.width > 0 && bounds.height > 0
  const display = known ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
  const area = display.workArea
  let x: number
  let y: number
  if (known) {
    x = Math.round(bounds.x + bounds.width / 2 - width / 2)
    // La barre de menus est en haut ; la barre des tâches, souvent en bas.
    y = bounds.y < area.y + area.height / 2 ? bounds.y + bounds.height + 6 : bounds.y - height - 6
  } else {
    x = area.x + area.width - width - 12
    y = isMac ? area.y + 6 : area.y + area.height - height - 12
  }
  x = Math.min(Math.max(x, area.x + 6), area.x + area.width - width - 6)
  y = Math.min(Math.max(y, area.y + 6), area.y + area.height - height - 6)
  return { x, y, width, height }
}

// ---- la permission de macOS ------------------------------------------------

// Sans la permission « Enregistrement de l'écran », macOS ne refuse pas : il
// rend une image où il n'y a que le fond d'écran. Rien ne dirait pourquoi, d'où
// la question posée avant.
async function screenAllowed(): Promise<boolean> {
  if (!isMac) return true
  const status = systemPreferences.getMediaAccessStatus("screen")
  if (status === "granted" || status === "not-determined") return true
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: "Zyvro Studio needs permission to record the screen",
    detail:
      "Turn on Zyvro Studio in System Settings › Privacy & Security › Screen & System Audio Recording, then quit and reopen Zyvro Studio.",
    buttons: ["Open System Settings", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
  }
  return false
}

// ---- choisir une zone --------------------------------------------------------

function selectArea(mode: "image" | "video"): Promise<{ display: Display; rect: Rect } | null> {
  closeOverlays()
  overlayMode = mode
  const cursor = screen.getCursorScreenPoint()
  const under = screen.getDisplayNearestPoint(cursor)
  return new Promise((resolve) => {
    selectionDone = resolve
    for (const display of screen.getAllDisplays()) {
      const win = captureWindow(
        {
          ...display.bounds,
          transparent: true,
          hasShadow: false,
          movable: false,
          enableLargerThanScreen: true,
          alwaysOnTop: true,
          backgroundColor: "#00000000",
          ...(isMac ? { acceptFirstMouse: true, roundedCorners: false } : {}),
        },
        "overlay"
      )
      win.setAlwaysOnTop(true, "screen-saver")
      if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.setContentProtection(true)
      win.once("ready-to-show", () => {
        win.setBounds(display.bounds)
        if (display.id === under.id) {
          win.show()
          win.focus()
        } else win.showInactive()
      })
      win.on("closed", () => {
        overlays.delete(win.id)
        if (overlays.size === 0) finishSelection(null)
      })
      overlays.set(win.id, { win, display })
    }
    // Échap partout, le temps de la sélection : une fenêtre qui n'a pas le
    // focus ne reçoit pas le clavier, et c'est souvent le cas sous macOS.
    try {
      globalShortcut.register("Escape", () => finishSelection(null))
    } catch {
      // La page écoute Échap aussi.
    }
  })
}

function finishSelection(chosen: { display: Display; rect: Rect } | null): void {
  const done = selectionDone
  selectionDone = null
  if (globalShortcut.isRegistered("Escape")) globalShortcut.unregister("Escape")
  closeOverlays()
  done?.(chosen)
}

function closeOverlays(): void {
  const open = [...overlays.values()]
  overlays = new Map()
  for (const { win } of open) if (!win.isDestroyed()) win.destroy()
}

// ---- une image ---------------------------------------------------------------

async function captureImage(): Promise<void> {
  if (busy !== "idle") return
  if (!(await screenAllowed())) return
  busy = "selecting"
  buildTrayMenu()
  try {
    const png = isMac ? await nativeAreaCapture() : await overlayAreaCapture()
    if (!png) return
    const size = nativeImage.createFromBuffer(png).getSize()
    last = { kind: "image", png, width: size.width, height: size.height, kept: null, published: null }
    last.kept = keepCopy([["png", png]])
    showResult()
  } catch (err) {
    void failed("The capture did not work.", err)
  } finally {
    busy = "idle"
    buildTrayMenu()
  }
}

// La sélection du système. Annulée, elle n'écrit pas de fichier.
async function nativeAreaCapture(): Promise<Buffer | null> {
  const file = path.join(os.tmpdir(), `zyvro-capture-${randomBytes(6).toString("hex")}.png`)
  await new Promise<void>((resolve) => {
    const child = spawn("/usr/sbin/screencapture", ["-i", "-x", file], { stdio: "ignore" })
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
  try {
    const png = await fs.promises.readFile(file)
    return png.length > 0 ? png : null
  } catch {
    return null
  } finally {
    void fs.promises.rm(file, { force: true })
  }
}

async function overlayAreaCapture(): Promise<Buffer | null> {
  const chosen = await selectArea("image")
  if (!chosen) return null
  // Les fenêtres de sélection sont fermées ; le temps que le compositeur les
  // retire de l'écran, sinon on photographierait leur voile.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const { display, rect } = chosen
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    },
  })
  const source = sourceFor(sources, display)
  if (!source || source.thumbnail.isEmpty()) throw new Error("this screen could not be read")
  const image = source.thumbnail
  return image.crop(pixelRect(rect, display.bounds, image.getSize())).toPNG()
}

function sourceFor<T extends { display_id: string }>(sources: T[], display: Display): T | undefined {
  return sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
}

// ---- une vidéo ---------------------------------------------------------------
//
// L'enregistreur est une fenêtre cachée : il faut un rendu pour MediaRecorder,
// et c'est lui qui recadre la zone et fabrique le GIF au fil de l'eau. Sa
// session lui est propre, et ne sait donner que l'écran choisi.

async function recordVideo(): Promise<void> {
  if (busy !== "idle") return
  if (!(await screenAllowed())) return
  busy = "selecting"
  buildTrayMenu()
  let chosen: { display: Display; rect: Rect } | null = null
  try {
    chosen = await selectArea("video")
  } finally {
    if (!chosen) {
      busy = "idle"
      buildTrayMenu()
    }
  }
  if (!chosen) return

  const { display, rect } = chosen
  busy = "recording"
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
    const source = sourceFor(sources, display)
    if (!source) throw new Error("this screen could not be found")

    const recording = session.fromPartition(RECORDER_PARTITION)
    recording.setDisplayMediaRequestHandler((_request, callback) => callback({ video: source }))
    recording.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "media" || permission === "display-capture")
    )

    recorderConfig = { rect, screen: { width: display.bounds.width, height: display.bounds.height }, maxMs: MAX_RECORDING_MS }
    const outcome = await new Promise<{ ok: true; payload: unknown } | { ok: false; message: string }>((resolve) => {
      recordingDone = resolve
      recorder = captureWindow(
        {
          width: 320,
          height: 240,
          // Caché, mais il doit continuer de tourner : sans ça, Chromium ralentit
          // les minuteries d'une page invisible et le GIF n'aurait qu'une image
          // par seconde.
          webPreferences: { partition: RECORDER_PARTITION, backgroundThrottling: false },
        },
        "recorder"
      )
      recorder.on("closed", () => {
        recorder = null
        endRecording({ ok: false, message: "The recorder stopped unexpectedly." })
      })
      // Le temps de démarrer, au plus.
      setTimeout(() => {
        if (busy === "recording" && recordingStarted === 0) {
          endRecording({ ok: false, message: "The recording did not start." })
        }
      }, 15_000)
    })
    if (!outcome.ok) throw new Error(outcome.message)
    const recorded = outcome.payload as {
      webm: Uint8Array
      gif: Uint8Array | null
      gifTooLarge: boolean
      width: number
      height: number
      ms: number
    }
    const webm = Buffer.from(recorded.webm)
    const gif = recorded.gif ? Buffer.from(recorded.gif) : null
    last = {
      kind: "video",
      webm,
      gif,
      gifTooLarge: Boolean(recorded.gifTooLarge),
      width: recorded.width,
      height: recorded.height,
      ms: recorded.ms,
      kept: null,
      published: null,
    }
    last.kept = keepCopy(gif ? [["webm", webm], ["gif", gif]] : [["webm", webm]])
    showResult()
  } catch (err) {
    void failed("The recording did not work.", err)
  } finally {
    tearDownRecording()
    busy = "idle"
    setRecordingLook(false)
  }
}

function recordingBegan(): void {
  if (!recorderConfig || busy !== "recording") return
  recordingStarted = Date.now()
  showRecordingFrame()
  setRecordingLook(true)
  recordingTimer = setInterval(() => {
    const elapsed = Date.now() - recordingStarted
    pill?.webContents.send("capture:tick", { elapsed, max: MAX_RECORDING_MS })
    if (isMac) tray?.setTitle(` ${formatElapsed(elapsed)}`)
    buildTrayMenu()
    // L'enregistreur s'arrête seul à la minute ; ceci est le filet.
    if (elapsed > MAX_RECORDING_MS + 3_000) stopRecording()
  }, 1000)
}

// Un cadre autour de la zone, et une pastille pour arrêter. Tous deux exclus
// des captures (`setContentProtection`) et posés hors de la zone quand il y a
// la place : ils ne doivent pas finir dans la vidéo.
function showRecordingFrame(): void {
  if (!recorderConfig || !lastSelection) return
  const { display, rect } = lastSelection
  const abs = { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height }
  const pad = 3
  border = captureWindow(
    {
      x: abs.x - pad,
      y: abs.y - pad,
      width: abs.width + pad * 2,
      height: abs.height + pad * 2,
      transparent: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      enableLargerThanScreen: true,
    },
    "border"
  )
  border.setIgnoreMouseEvents(true)
  border.setContentProtection(true)
  border.setAlwaysOnTop(true, "screen-saver")
  border.once("ready-to-show", () => border?.showInactive())

  const w = 212
  const h = 40
  const area = display.workArea
  let x = Math.round(abs.x + abs.width / 2 - w / 2)
  let y = abs.y + abs.height + pad + 8
  if (y + h > area.y + area.height) y = abs.y - pad - 8 - h
  if (y < area.y) y = abs.y + 8 // ni dessous ni dessus : dans la zone, exclue de la capture
  x = Math.min(Math.max(x, area.x + 6), area.x + area.width - w - 6)
  pill = captureWindow(
    {
      x,
      y,
      width: w,
      height: h,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      ...(isMac ? { acceptFirstMouse: true } : {}),
    },
    "pill"
  )
  pill.setContentProtection(true)
  pill.setAlwaysOnTop(true, "screen-saver")
  pill.once("ready-to-show", () => pill?.showInactive())
}


function stopRecording(): void {
  if (busy !== "recording" || !recorder || recorder.isDestroyed()) return
  recorder.webContents.send("capture:stop")
}

function endRecording(outcome: { ok: true; payload: unknown } | { ok: false; message: string }): void {
  const done = recordingDone
  recordingDone = null
  done?.(outcome)
}

function tearDownRecording(): void {
  if (recordingTimer) clearInterval(recordingTimer)
  recordingTimer = null
  recordingStarted = 0
  recorderConfig = null
  lastSelection = null
  for (const win of [border, pill, recorder]) if (win && !win.isDestroyed()) win.destroy()
  border = null
  pill = null
  recorder = null
}

// ---- garder, montrer --------------------------------------------------------

// keepCopy : une copie dans le dossier choisi, s'il y en a un. Une copie
// ratée ne fait pas échouer la capture ; la fenêtre de résultat dira où elle
// est, ou ne dira rien.
function keepCopy(files: [string, Buffer][]): string | null {
  if (!settings.keepDir) return null
  try {
    fs.mkdirSync(settings.keepDir, { recursive: true })
    const now = new Date()
    let first: string | null = null
    for (const [extension, bytes] of files) {
      const file = path.join(settings.keepDir, captureName(extension, now))
      fs.writeFileSync(file, bytes)
      first ??= file
    }
    return first
  } catch (err) {
    console.error("[capture] copie locale:", err)
    return null
  }
}

function showResult(): void {
  if (result && !result.isDestroyed()) result.destroy()
  const bounds = nearTray(400, last?.kind === "video" ? 480 : 440)
  result = captureWindow(
    {
      ...bounds,
      alwaysOnTop: true,
      backgroundColor: "#0b0b0f",
      ...(isMac ? { acceptFirstMouse: true } : {}),
    },
    "result"
  )
  result.once("ready-to-show", () => result?.show())
  result.on("closed", () => {
    result = null
    void askAboutLogin()
  })
}

// Une fois, après la première capture : la question de l'icône au démarrage.
// Non par défaut ; réglable ensuite dans Settings.
async function askAboutLogin(): Promise<void> {
  if (settings.loginAsked || !app.isPackaged) return
  settings = { ...settings, loginAsked: true }
  saveSettings()
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Start Zyvro Studio when you log in?",
    detail: `It starts in the background, so the capture icon is always in the ${
      isMac ? "menu bar" : "notification area"
    }. You can change this later in Settings.`,
    buttons: ["Start at Login", "Not Now"],
    defaultId: 1,
    cancelId: 1,
  })
  if (response === 0) {
    settings = { ...settings, launchAtLogin: true }
    saveSettings()
    applyLoginItem()
  }
}

async function failed(message: string, err: unknown): Promise<void> {
  console.error("[capture]", message, err)
  await dialog.showMessageBox({
    type: "error",
    message,
    detail: err instanceof Error ? err.message : String(err),
  })
}

// ---- le passage avec les fenêtres -------------------------------------------

function registerIpc(): void {
  ipcMain.handle("capture:overlay-info", (event) => {
    const entry = [...overlays.values()].find(({ win }) => sentBy(event, win))
    if (!entry) throw new Error("not a selection window")
    return { mode: overlayMode, width: entry.display.bounds.width, height: entry.display.bounds.height }
  })

  ipcMain.handle("capture:select", (event, rect: Rect | null) => {
    const entry = [...overlays.values()].find(({ win }) => sentBy(event, win))
    if (!entry) throw new Error("not a selection window")
    const valid =
      rect &&
      [rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n)) &&
      rect.width >= 1 &&
      rect.height >= 1
    const chosen = valid ? { display: entry.display, rect } : null
    lastSelection = chosen
    finishSelection(chosen)
  })

  ipcMain.handle("capture:recorder-config", (event) => {
    if (!sentBy(event, recorder) || !recorderConfig) throw new Error("not the recorder")
    return recorderConfig
  })
  ipcMain.handle("capture:recorder-started", (event) => {
    if (!sentBy(event, recorder)) throw new Error("not the recorder")
    recordingBegan()
  })
  ipcMain.handle("capture:recorded", (event, payload: unknown) => {
    if (!sentBy(event, recorder)) throw new Error("not the recorder")
    const p = payload as { webm?: unknown }
    if (!(p?.webm instanceof Uint8Array) || p.webm.length === 0) {
      endRecording({ ok: false, message: "Nothing was recorded." })
      return
    }
    endRecording({ ok: true, payload })
  })
  ipcMain.handle("capture:record-failed", (event, message: unknown) => {
    if (!sentBy(event, recorder)) throw new Error("not the recorder")
    endRecording({ ok: false, message: String(message || "The recording failed.") })
  })
  ipcMain.handle("capture:stop-request", (event) => {
    if (!sentBy(event, pill)) throw new Error("not the recording control")
    stopRecording()
  })

  const fromResult = (event: IpcMainInvokeEvent) => {
    if (!sentBy(event, result)) throw new Error("not the capture window")
    if (!last) throw new Error("There is no capture.")
    return last
  }

  ipcMain.handle("capture:current", async (event) => {
    if (!sentBy(event, result)) throw new Error("not the capture window")
    if (!last) return null
    const signedIn = Boolean(await currentAccount().catch(() => null))
    if (last.kind === "image") {
      return {
        kind: "image",
        preview: `data:image/png;base64,${last.png.toString("base64")}`,
        width: last.width,
        height: last.height,
        kept: last.kept,
        signedIn,
      }
    }
    return {
      kind: "video",
      webm: new Uint8Array(last.webm),
      width: last.width,
      height: last.height,
      ms: last.ms,
      hasGif: last.gif !== null,
      gifTooLarge: last.gifTooLarge,
      kept: last.kept,
      signedIn,
    }
  })

  ipcMain.handle("capture:copy-image", async (event) => {
    const capture = fromResult(event)
    if (capture.kind !== "image") throw new Error("Only an image can be copied.")
    await clipboard.write([
      new ClipboardItem({ "image/png": new Blob([new Uint8Array(capture.png)], { type: "image/png" }) }),
    ])
  })

  ipcMain.handle("capture:save", async (event, format: unknown) => {
    const capture = fromResult(event)
    const bytes =
      capture.kind === "image"
        ? format === "png"
          ? capture.png
          : null
        : format === "webm"
          ? capture.webm
          : format === "gif"
            ? capture.gif
            : null
    if (!bytes) throw new Error("There is nothing to save in that format.")
    const extension = String(format)
    const owner = result ?? undefined
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(settings.keepDir ?? app.getPath("downloads"), captureName(extension)),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    }
    const { canceled, filePath } = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return null
    await fs.promises.writeFile(filePath, bytes)
    return filePath
  })

  ipcMain.handle("capture:publish", async (event) => {
    const capture = fromResult(event)
    if (capture.published) return capture.published
    if (!(await currentAccount().catch(() => null))) {
      throw new Error("Sign in to Zyvro Studio to publish a capture.")
    }
    const form = new FormData()
    if (capture.kind === "image") {
      form.append("file", new Blob([new Uint8Array(capture.png)], { type: "image/png" }), captureName("png"))
    } else {
      form.append("file", new Blob([new Uint8Array(capture.webm)], { type: "video/webm" }), captureName("webm"))
      if (capture.gif) {
        form.append("gif", new Blob([new Uint8Array(capture.gif)], { type: "image/gif" }), captureName("gif"))
      }
    }
    const published = parsePublished(await authorized("/api/shots", { method: "POST", body: form }))
    capture.published = published
    // Le lien est ce qu'on est venu chercher : il est déjà dans le
    // presse-papier quand la fenêtre le montre.
    await clipboard.writeText(published.url)
    return published
  })

  ipcMain.handle("capture:copy-text", async (event, text: unknown) => {
    const capture = fromResult(event)
    // Seulement un lien que le serveur a rendu pour cette capture : la fenêtre
    // n'écrit pas ce qu'elle veut dans le presse-papier.
    const links = [capture.published?.url, capture.published?.gifUrl].filter(Boolean)
    if (typeof text !== "string" || !links.includes(text)) throw new Error("not a link of this capture")
    await clipboard.writeText(text)
  })

  ipcMain.handle("capture:reveal", (event) => {
    const capture = fromResult(event)
    if (capture.kept) shell.showItemInFolder(capture.kept)
  })

  ipcMain.handle("capture:open-studio", (event) => {
    if (!sentBy(event, result)) throw new Error("not the capture window")
    deps?.openStudio()
  })

  ipcMain.handle("capture:close", (event) => {
    if (!sentBy(event, result)) throw new Error("not the capture window")
    result?.close()
  })

  // Les réglages, depuis l'onglet Settings d'une fenêtre de Studio.
  ipcMain.handle("capture:settings", () => view())
  ipcMain.handle("capture:update-settings", (_event, patch: unknown) => {
    const before = settings
    settings = sanitizeCapture({ ...settings, ...(patch && typeof patch === "object" ? patch : {}) })
    saveSettings()
    if (settings.launchAtLogin !== before.launchAtLogin) applyLoginItem()
    if (settings.shortcutImage !== before.shortcutImage || settings.shortcutVideo !== before.shortcutVideo) {
      registerShortcuts()
    }
    buildTrayMenu()
    return view()
  })
  ipcMain.handle("capture:choose-folder", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: "Keep a copy of every capture in…",
      defaultPath: settings.keepDir ?? path.join(app.getPath("pictures"), "Zyvro Captures"),
      properties: ["openDirectory", "createDirectory"],
    }
    const { canceled, filePaths } = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (!canceled && filePaths[0]) {
      settings = sanitizeCapture({ ...settings, keepDir: filePaths[0] })
      saveSettings()
    }
    return view()
  })
}

// ---- le démarrage -----------------------------------------------------------

export function startCapture(d: Deps): void {
  deps = d
  settings = loadSettings()
  registerIpc()

  tray = new Tray(trayImage(false))
  tray.setToolTip("Zyvro Studio — capture")
  buildTrayMenu()
  // Sous Windows, le clic gauche ne fait rien de lui-même : il ouvre le menu,
  // ou arrête l'enregistrement en cours.
  if (!isMac) {
    tray.on("click", () => {
      if (busy === "recording") stopRecording()
      else tray?.popUpContextMenu()
    })
  }

  registerShortcuts()
  applyLoginItem()

  app.on("will-quit", () => globalShortcut.unregisterAll())
}

// La dernière fenêtre fermée : sous Windows et Linux, l'app reste dans la zone
// de notification pour que l'icône continue de servir. On le dit une fois,
// sinon on croirait l'avoir quittée.
export function lastWindowClosed(): void {
  if (!tray || settings.trayNoticeShown) return
  settings = { ...settings, trayNoticeShown: true }
  saveSettings()
  if (process.platform === "win32") {
    tray.displayBalloon({
      title: "Zyvro Studio is still running",
      content: "The capture icon stays here. Right-click it and choose Quit to close Zyvro Studio.",
      iconType: "info",
    })
  }
}
