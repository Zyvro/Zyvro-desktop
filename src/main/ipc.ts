import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import path from "node:path"
import { Daemon, DaemonError, type DaemonInfo } from "./daemon"
import type { UpdateController } from "./updateController"
import { Terminals } from "./terminal"
import { AgentRunner, type AgentContext, type AgentKind } from "./agent"
import fs from "node:fs/promises"
import * as files from "./files"
import { forgetRecents, loadRecents, rememberRecent } from "./recents"
import { currentAccount, signIn, signOut } from "./account"
import * as store from "./store"

// One Workspace per window: an open project folder, the daemon that serves it,
// the shells running in it and the agent turns in flight. Bundling them means
// closing a window tears all four down together instead of leaking a daemon.
export class Workspace {
  root: string | null = null
  readonly daemon = new Daemon()
  readonly terminals = new Terminals()
  readonly agent = new AgentRunner()

  async dispose(): Promise<void> {
    this.agent.cancelAll()
    this.terminals.disposeAll()
    await this.daemon.stop()
  }
}

// realpathOfParent resolves a chosen path through symlinks without requiring
// the file itself to exist, which matters for a save dialog naming a file that
// is about to be created. On macOS this is not optional: /tmp is a symlink, so
// a path under it measures as outside the project unless both sides are
// resolved the same way.
async function realpathOfParent(target: string): Promise<string> {
  const parent = await fs.realpath(path.dirname(target))
  return path.join(parent, path.basename(target))
}

const workspaces = new WeakMap<BrowserWindow, Workspace>()

export function workspaceFor(win: BrowserWindow): Workspace {
  let ws = workspaces.get(win)
  if (!ws) {
    ws = new Workspace()
    workspaces.set(win, ws)
  }
  return ws
}

// requireWorkspace resolves the window that sent an IPC message. Trusting a
// window id from the renderer instead would let one window drive another's
// daemon, so the sender is the only accepted source of identity.
function requireWorkspace(event: Electron.IpcMainInvokeEvent): { win: BrowserWindow; ws: Workspace } {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error("This request came from a window that no longer exists.")
  return { win, ws: workspaceFor(win) }
}

function requireRoot(ws: Workspace): string {
  if (!ws.root) throw new Error("No project is open.")
  return ws.root
}

export type OpenResult = { project: string; name: string; daemon: DaemonInfo }

// onRecentsChanged lets the main process rebuild the File menu when the recent
// list changes, since an Electron menu is a static structure that has to be
// replaced rather than mutated.
let onRecentsChanged: (() => void) | null = null

export function registerIpc(onRecents?: () => void, updates?: UpdateController): void {
  onRecentsChanged = onRecents ?? null

  // The engine update surface. Note what is not here: no channel that takes a
  // URL or a manifest from the renderer. The controller installs the release it
  // fetched and verified itself, so a compromised window can ask for an install
  // but cannot choose what gets installed.
  ipcMain.handle("engine-update:state", async () => updates?.snapshot() ?? { status: "idle" })
  ipcMain.handle("engine-update:check", async () => updates?.check() ?? { status: "idle" })
  ipcMain.handle("engine-update:install", async () => updates?.install() ?? { status: "idle" })
  ipcMain.handle("engine-update:dismiss", async () => {
    updates?.dismiss()
    return updates?.snapshot() ?? { status: "idle" }
  })
  ipcMain.handle("project:choose", async (event) => {
    const { win } = requireWorkspace(event)
    const result = await dialog.showOpenDialog(win, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open project",
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Opening assumed the folder already existed, which left the app with no
  // answer at all to "I want to start something new" — the one thing a person
  // does on first launch. A Zyvro project is only a folder the engine has put a
  // .zyvro directory inside, so creating one is: name it, make it, open it.
  //
  // A save dialog rather than an open dialog, because this is the one that lets
  // someone type a name that does not exist yet. The open dialog's "New Folder"
  // button is a macOS affordance buried inside a panel whose whole framing is
  // "choose something that is already there".
  ipcMain.handle("project:create", async (event) => {
    const { win } = requireWorkspace(event)
    const result = await dialog.showSaveDialog(win, {
      title: "Create a project",
      buttonLabel: "Create project",
      nameFieldLabel: "Project name",
      defaultPath: path.join(app.getPath("documents"), "zyvro-project"),
      properties: ["createDirectory"],
    })
    if (result.canceled || !result.filePath) return null

    const target = result.filePath
    const existing = await fs.stat(target).catch(() => null)
    if (existing && !existing.isDirectory()) {
      throw new Error(`There is already a file at ${target}. Choose another name.`)
    }
    // An existing folder is not an error: a save panel only hands one back when
    // the person typed its name on purpose, and opening it is what they asked
    // for. mkdir is skipped rather than allowed to fail on it.
    if (!existing) await fs.mkdir(target, { recursive: true })
    return target
  })

  ipcMain.handle("project:open", async (event, dir: string): Promise<OpenResult> => {
    const { win, ws } = requireWorkspace(event)
    if (typeof dir !== "string" || !dir) throw new Error("A project path is required.")
    try {
      const daemon = await ws.daemon.start(dir)
      ws.root = dir
      win.setTitle(`${path.basename(dir)} — Zyvro Studio`)
      win.setRepresentedFilename?.(dir)
      // Only a folder that opened successfully is worth offering again.
      rememberRecent(dir)
      onRecentsChanged?.()
      return { project: dir, name: path.basename(dir), daemon }
    } catch (err) {
      ws.root = null
      if (err instanceof DaemonError) {
        throw new Error(err.detail ? `${err.message}\n\n${err.detail}` : err.message)
      }
      throw err
    }
  })

  ipcMain.handle("project:current", async (event) => {
    const { ws } = requireWorkspace(event)
    if (!ws.root || !ws.daemon.current) return null
    return { project: ws.root, name: path.basename(ws.root), daemon: ws.daemon.current }
  })

  ipcMain.handle("project:recents", async () => loadRecents())

  ipcMain.handle("project:forget-recents", async () => {
    const recents = forgetRecents()
    onRecentsChanged?.()
    return recents
  })

  ipcMain.handle("project:close", async (event) => {
    const { ws } = requireWorkspace(event)
    await ws.dispose()
    ws.root = null
    return true
  })

  // The graph editor asks for this when someone clicks Browse on a Read File
  // or Write File node. It returns a path relative to the project, because that
  // is what goes into the workflow: an absolute path would break the moment the
  // workflow was opened on another machine, and workflows are meant to be
  // committed and shared.
  ipcMain.handle(
    "files:pick",
    async (event, request: { save?: boolean; title?: string; current?: string }) => {
      const { win, ws } = requireWorkspace(event)
      const root = await fs.realpath(requireRoot(ws))
      const startIn = request?.current
        ? path.resolve(root, path.dirname(request.current))
        : root

      const chosen = request?.save
        ? await dialog.showSaveDialog(win, {
            title: request?.title || "Write to",
            defaultPath: request.current ? path.resolve(root, request.current) : root,
            buttonLabel: "Use this path",
          })
        : await dialog.showOpenDialog(win, {
            title: request?.title || "Choose a file",
            defaultPath: startIn,
            properties: ["openFile"],
            buttonLabel: "Use this file",
          })

      const picked =
        "filePath" in chosen ? chosen.filePath : chosen.filePaths?.[0]
      if (chosen.canceled || !picked) return null

      const relative = path.relative(root, await realpathOfParent(picked))
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          "That file is outside the open project. Workflows can only read and write inside the project folder."
        )
      }
      return relative.split(path.sep).join("/")
    }
  )

  ipcMain.handle("files:list", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    return files.listDir(requireRoot(ws), relative ?? ".")
  })

  ipcMain.handle("files:read", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    return files.readFile(requireRoot(ws), relative)
  })

  ipcMain.handle("files:write", async (event, relative: string, text: string) => {
    const { ws } = requireWorkspace(event)
    await files.writeFile(requireRoot(ws), relative, String(text))
    return true
  })

  ipcMain.handle("files:create", async (event, relative: string, kind: "file" | "directory") => {
    const { ws } = requireWorkspace(event)
    await files.createEntry(requireRoot(ws), relative, kind === "directory" ? "directory" : "file")
    return true
  })

  ipcMain.handle("files:rename", async (event, from: string, to: string) => {
    const { ws } = requireWorkspace(event)
    await files.renameEntry(requireRoot(ws), from, to)
    return true
  })

  ipcMain.handle("files:delete", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    await files.deleteEntry(requireRoot(ws), relative)
    return true
  })

  ipcMain.handle("terminal:create", async (event, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    return ws.terminals.create(event.sender, requireRoot(ws), cols || 80, rows || 24)
  })

  ipcMain.handle("terminal:write", async (event, id: string, data: string) => {
    const { ws } = requireWorkspace(event)
    ws.terminals.write(id, data)
    return true
  })

  ipcMain.handle("terminal:resize", async (event, id: string, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    ws.terminals.resize(id, cols, rows)
    return true
  })

  ipcMain.handle("terminal:dispose", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.terminals.dispose(id)
    return true
  })

  ipcMain.handle(
    "agent:send",
    async (event, kind: AgentKind, prompt: string, ctx: Partial<AgentContext>) => {
      const { ws } = requireWorkspace(event)
      const root = requireRoot(ws)
      return ws.agent.send(event.sender, kind === "codex" ? "codex" : "claude", String(prompt), {
        projectDir: root,
        workflows: Array.isArray(ctx?.workflows) ? ctx.workflows : [],
        daemonOrigin: ws.daemon.current?.origin,
        daemonToken: ws.daemon.current?.token,
      })
    }
  )

  ipcMain.handle("agent:cancel", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.cancel(id)
    return true
  })

  // The account lives in the main process. The renderer can ask who is signed
  // in and ask for a publish, but is never handed the credential.
  ipcMain.handle("account:current", async () => currentAccount())
  ipcMain.handle("account:sign-in", async (_event, email: string, password: string) =>
    signIn(String(email), String(password))
  )
  ipcMain.handle("account:sign-out", async () => {
    await signOut()
    return null
  })

  ipcMain.handle("store:nodes", async (_event, q: string) => store.listNodes(String(q ?? "")))
  ipcMain.handle("store:workflows", async (_event, q: string) => store.listWorkflows(String(q ?? "")))
  // Reading a pack installs nothing. It is what lets someone look at the Lua
  // before deciding to trust it, which is the only review this store has.
  ipcMain.handle("store:read-pack", async (_event, name: string, version?: string) =>
    store.readPack(String(name), version ? String(version) : undefined)
  )

  ipcMain.handle("store:install-pack", async (event, name: string, version?: string) => {
    const { ws } = requireWorkspace(event)
    return store.installPack(requireRoot(ws), String(name), version ? String(version) : undefined)
  })

  ipcMain.handle("store:install-workflow", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return store.installWorkflow(requireRoot(ws), String(name))
  })

  ipcMain.handle("store:installed-packs", async (event) => {
    const { ws } = requireWorkspace(event)
    return store.listInstalledPacks(requireRoot(ws))
  })

  ipcMain.handle("store:publish-pack", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return store.publishPack(requireRoot(ws), String(name))
  })

  ipcMain.handle(
    "store:publish-workflow",
    async (event, payload: { id: string; name: string; description: string; graph: unknown }) => {
      requireWorkspace(event)
      return store.publishWorkflow(payload)
    }
  )

  // Opening a link goes through the OS browser, never a new Electron window: a
  // window without our preload would still have Chromium privileges.
  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("Refused to open a non-web URL.")
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle("shell:reveal", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    const target = await files.resolveInside(requireRoot(ws), relative)
    shell.showItemInFolder(target)
    return true
  })
}

export async function disposeWorkspace(win: BrowserWindow): Promise<void> {
  const ws = workspaces.get(win)
  if (ws) await ws.dispose()
}
