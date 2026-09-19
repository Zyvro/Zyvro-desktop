import { app, BrowserWindow, Menu, nativeImage, session, shell } from "electron"
import path from "node:path"
import { askHost, browserHost, registerIpc, disposeWorkspace, workspaceFor } from "./ipc"
import { startShotsServer } from "./shots"
import { BROWSER_PARTITION, noteRequest } from "./browser"
import { loadRecents } from "./recents"
import { bundledBinary } from "./daemon"
import { prepare as prepareCliPath } from "./cli"
import { appContextTemplate } from "./contextmenu"
import fs from "node:fs"

const isDev = !app.isPackaged


// scripts/dev-app-name.mjs renames the development Electron bundle so the menu
// bar stops saying "Electron". That rename has a side effect worth blocking:
// the user folder is derived from the app name, so development would quietly
// move onto the packaged app's profile — its recents, its signed-in account.
// Those are worth keeping apart, and a dev run that wiped the real one would be
// a bad way to find that out.
if (isDev) {
  app.setPath("userData", path.join(app.getPath("appData"), "zyvro-desktop"))
}

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
      // Le navigateur de test est une <webview> : un WebContents à part, avec
      // sa propre session, que l'agent pilote sans toucher au navigateur de la
      // personne. `will-attach-webview` ci-dessous fixe ce qu'elle a le droit
      // d'être — l'attribut ne dit pas « le rendu peut tout », il dit « le rendu
      // peut en demander une ».
      webviewTag: true,
      spellcheck: false,
    },
  })

  // Ce qu'une <webview> a le droit d'être, décidé ici et pas dans le HTML qui
  // la demande : les préférences arrivent du rendu, et un rendu compromis
  // demanderait Node dans la page qu'il affiche. On les remplace.
  win.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    // Les boîtes de dialogue de la page — alert, confirm, prompt — bloquent le
    // rendu jusqu'à ce que quelqu'un clique. Un agent ne peut pas cliquer
    // dedans : la page resterait figée et l'outil n'aurait plus qu'à expirer.
    // Désactivées, `confirm` rend « non » et la page continue.
    webPreferences.disableDialogs = true
    // Une seule session, la sienne : ni celle de l'application, ni celle du
    // navigateur de la personne.
    params.partition = BROWSER_PARTITION
    params.allowpopups = "false"
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

  // Le clic droit sur la fenêtre de l'application.
  //
  // Il n'y en avait pas : seule la vue invitée du navigateur en avait un. Avec
  // le menu Édition et son raccourci, Cmd+C marchait — mais seulement pour qui
  // pense à le chercher, et seulement une fois qu'il y a quelque chose de
  // sélectionné. « Impossible de copier les textes d'erreur et les prompts. »
  //
  // Le nécessaire, et rien de plus : ce qu'on vise, et de quoi tout prendre.
  // Les rôles plutôt que des actions écrites à la main — ils portent les
  // raccourcis du système et le grisé quand il n'y a rien à coller.
  win.webContents.on("context-menu", (_event, params) => {
    const items = appContextTemplate(params.selectionText, params.isEditable)
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window: win })
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
    // Dit tout de suite, pas à l'envoi : la fenêtre demande un moteur dès
    // qu'elle est montée, et ce drapeau est ce qui l'empêche d'en démarrer un
    // second qui se battrait avec celui-ci.
    workspaceFor(win).startupPending = true
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
          label: "New Project…",
          accelerator: "CmdOrCtrl+N",
          click: (_item, win) => send(win as BrowserWindow, "menu:new-project"),
        },
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
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        // Les deux recherches, et le raccourci que tout le monde a dans les
        // doigts. Sans une entrée de menu, l'accélérateur n'existe pas pour le
        // système : ⌘F n'atteindrait l'éditeur que lorsqu'il a déjà le focus, et
        // ⇧⌘F n'ouvrirait jamais le panneau.
        {
          label: "Find in File",
          accelerator: "CmdOrCtrl+F",
          click: (_item, win) => send(win as BrowserWindow, "menu:find-in-file"),
        },
        {
          label: "Find in Project",
          accelerator: "CmdOrCtrl+Shift+F",
          click: (_item, win) => send(win as BrowserWindow, "menu:find-in-project"),
        },
      ],
    },
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
        {
          // La même commande que celle qu'un agent déclenche : l'onglet
          // navigateur n'appartient pas à l'agent, c'est l'onglet de la
          // personne, qu'un agent peut aussi ouvrir.
          label: "Test Browser",
          accelerator: "CmdOrCtrl+Shift+B",
          click: (_item, win) => send(win as BrowserWindow, "browser:open"),
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

// forgetDownloadedEngines removes anything the old update channel left behind.
//
// Those binaries were fetched over the network and checked against a key that
// shipped in this repository as a placeholder. Nothing launches them any more,
// so they are already harmless — but an unused executable that arrived that way
// is not something to leave sitting in the user's folder.
async function forgetDownloadedEngines(): Promise<void> {
  const root = path.join(app.getPath("userData"), "engines")
  try {
    await fs.promises.rm(root, { recursive: true, force: true })
  } catch {
    // Best effort. Failing to delete a directory nothing reads is not a reason
    // to stop the app from starting.
  }
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

  void app.whenReady().then(async () => {
    // Before anything is spawned. A window opened from the Finder starts with
    // the system PATH and nothing else, so the local engine, the shells, the
    // agent and the commit-message CLI would all be looking in the wrong places
    // — and every one of them inherits this environment the moment it starts.
    await prepareCliPath(["claude", "codex"])

    // The dock reads its icon separately from the window's, and in development
    // there is no bundle for it to read one from.
    if (isDev && process.platform === "darwin") {
      const icon = appIcon()
      if (icon) app.dock?.setIcon(icon)
    }
    void forgetDownloadedEngines()

    // Le serveur de capture, démarré avant la première fenêtre : la
    // configuration MCP d'un tour d'agent est écrite au moment du tour, et elle
    // ne peut nommer que ce qui écoute déjà. Il rend toutes les fenêtres
    // ouvertes, pas seulement la principale — l'app en a une par projet.
    void startShotsServer(() => BrowserWindow.getAllWindows(), browserHost, askHost).catch((err) => {
      console.error("[shots] le serveur de capture n'a pas démarré:", err)
    })

    // Ce qui rate dans la page du navigateur de test. Seulement ce qui rate :
    // une page ordinaire fait des centaines de requêtes réussies, et elles
    // chasseraient du journal la seule qui explique la panne.
    const browsing = session.fromPartition(BROWSER_PARTITION)
    // Aucune permission accordée dans le navigateur de test : ni caméra, ni
    // micro, ni position, ni notifications. Un agent qui clique dans une page
    // n'est pas quelqu'un qui peut dire oui à sa place.
    browsing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browsing.webRequest.onCompleted((details) => {
      if (!details.webContentsId || details.statusCode < 400) return
      noteRequest(details.webContentsId, { url: details.url, status: details.statusCode })
    })
    browsing.webRequest.onErrorOccurred((details) => {
      if (!details.webContentsId) return
      noteRequest(details.webContentsId, { url: details.url, status: 0, error: details.error })
    })

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
