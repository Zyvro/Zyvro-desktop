import { app, BrowserWindow, Menu, nativeImage, shell } from "electron"
import path from "node:path"
import { registerIpc, disposeWorkspace, workspaceFor } from "./ipc"
import { loadRecents } from "./recents"
import fs from "node:fs"

const isDev = !app.isPackaged

// A packaged app takes its icon from the bundle, but a development run and the
// Windows and Linux taskbars take it from here. Without this, the app runs
// under the default Electron logo for the whole of development.
function appIcon(): Electron.NativeImage | undefined {
  const candidates = [
    path.join(process.resourcesPath || "", "icon.png"),
    path.join(app.getAppPath(), "resources", "icon.png"),
  ]
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return undefined
}

// folderFromArgv lets the app be launched the way an editor usually is, with a
// path: `zyvro-studio .` or `zyvro-studio ~/code/thing`. Electron's own flags
// and, in development, the "." that stands for the app directory itself have to
// be skipped, so only an argument that is a real directory counts.
function folderFromArgv(argv: string[]): string | null {
  const args = argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args) {
    if (arg.startsWith("-") || arg === ".") continue
    try {
      if (fs.statSync(arg).isDirectory()) return path.resolve(arg)
    } catch {
      // Not a path. Electron passes plenty of things that are not.
    }
  }
  return null
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0f",
    icon: appIcon(),
    // A hidden title bar with inset traffic lights is what makes the window
    // read as an editor rather than a web page in a frame.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      // The renderer compiles workflow graphs and renders model output. It gets
      // no Node access at all; everything it needs arrives over the narrow
      // surface in preload/index.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false,
    },
  })

  // Showing only once the first frame is painted avoids the white flash that
  // makes a dark-themed editor look broken on launch.
  win.once("ready-to-show", () => win.show())

  // A renderer exception in a desktop app is otherwise invisible: there is no
  // console for the user to open and no server log to read. Forwarding errors
  // and warnings to the process output makes a broken window diagnosable from
  // the terminal that launched it.
  win.webContents.on("console-message", (event) => {
    if (event.level !== "error" && event.level !== "warning") return
    console.error(`[renderer ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer gone] ${details.reason} (exit code ${details.exitCode})`)
  })

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload error] ${preloadPath}: ${error.message}`)
  })

  // Anything that tries to open a window goes to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  // The renderer is a local bundle; a navigation away from it would only ever
  // be a mistake or an injection, so refuse it outright.
  win.webContents.on("will-navigate", (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && url.startsWith(dev)) return
    event.preventDefault()
  })

  win.on("closed", () => {
    void disposeWorkspace(win)
  })

  workspaceFor(win)

  // A folder named on the command line opens once the renderer is listening.
  // Sending it earlier would be shouting at a window with no React in it yet.
  const startupFolder = folderFromArgv(process.argv)
  if (startupFolder) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("menu:open-path", startupFolder)
    })
  }

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"))
  }
  return win
}

function send(win: Electron.BrowserWindow | undefined, channel: string, payload?: unknown): void {
  if (win instanceof BrowserWindow) win.webContents.send(channel, payload)
}

// recentSubmenu is rebuilt from disk every time the menu is constructed. An
// Electron menu is a static structure, so "keeping it up to date" really means
// replacing the whole menu whenever the recent list changes.
function recentSubmenu(): Electron.MenuItemConstructorOptions[] {
  const recents = loadRecents()
  if (recents.length === 0) {
    return [{ label: "No recent projects", enabled: false }]
  }
  return [
    ...recents.map((recent) => ({
      label: recent.name,
      // The full path is the useful part when two folders share a name, and a
      // sublabel keeps it out of the way until the user looks for it.
      sublabel: recent.path,
      toolTip: recent.path,
      click: (_item: Electron.MenuItem, win?: Electron.BaseWindow) =>
        send(win as Electron.BrowserWindow, "menu:open-path", recent.path),
    })),
    { type: "separator" },
    {
      label: "Clear Recently Opened",
      click: (_item: Electron.MenuItem, win?: Electron.BaseWindow) =>
        send(win as Electron.BrowserWindow, "menu:forget-recents"),
    },
  ]
}

function buildMenu(): void {
  const isMac = process.platform === "darwin"
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => createWindow(),
        },
        { type: "separator" },
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: (_item, win) => send(win as BrowserWindow, "menu:open-project"),
        },
        { label: "Open Recent", submenu: recentSubmenu() },
        { type: "separator" },
        {
          label: "New Workflow",
          accelerator: "CmdOrCtrl+Alt+N",
          click: (_item, win) => send(win as BrowserWindow, "menu:new-workflow"),
        },
        {
          label: "Save",
          accelerator: "CmdOrCtrl+S",
          click: (_item, win) => send(win as BrowserWindow, "menu:save"),
        },
        { type: "separator" },
        {
          label: "Close Folder",
          accelerator: "CmdOrCtrl+K CmdOrCtrl+F",
          click: (_item, win) => send(win as BrowserWindow, "menu:close-project"),
        },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: (_item, win) => send(win as BrowserWindow, "menu:toggle-sidebar"),
        },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: (_item, win) => send(win as BrowserWindow, "menu:toggle-terminal"),
        },
        {
          label: "Toggle Agent",
          accelerator: "CmdOrCtrl+Shift+A",
          click: (_item, win) => send(win as BrowserWindow, "menu:toggle-agent"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// One instance owns the app. A second launch focuses the existing window
// instead of starting a rival daemon against the same project folder.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    const folder = folderFromArgv(argv)
    const [win] = BrowserWindow.getAllWindows()
    if (!win) {
      createWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
    // `zyvro-studio ~/other-project` from a second terminal should open that
    // folder rather than silently do nothing.
    if (folder) win.webContents.send("menu:open-path", folder)
  })

  void app.whenReady().then(() => {
    // The dock reads its icon separately from the window's, and in development
    // there is no bundle for it to read one from.
    if (isDev && process.platform === "darwin") {
      const icon = appIcon()
      if (icon) app.dock?.setIcon(icon)
    }
    registerIpc(buildMenu)
    buildMenu()
    createWindow()

    app.on("open-file", (event, filePath) => {
      event.preventDefault()
      const [win] = BrowserWindow.getAllWindows()
      if (win) win.webContents.send("menu:open-path", filePath)
      else createWindow()
    })

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  // Every daemon and shell is a child process of this one. Quitting without
  // reaping them would leave them running after the dock icon disappears.
  app.on("before-quit", () => {
    for (const win of BrowserWindow.getAllWindows()) void disposeWorkspace(win)
  })
}
