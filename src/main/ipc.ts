import { app, BrowserWindow, dialog, ipcMain, shell, webContents } from "electron"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Daemon, DaemonError, type DaemonInfo } from "./daemon"
import { Terminals } from "./terminal"
import { AgentRunner, type AgentContext, type AgentKind } from "./agent"
import { DEFAULT_PERMISSION, PERMISSIONS, type Permission } from "../shared/permission"
import * as agentModule from "./agent"
import { helpOf } from "./cli"
import fs from "node:fs/promises"
import * as files from "./files"
import { forgetRecents, loadRecents, rememberRecent } from "./recents"
import { authorized, currentAccount, signIn, signOut } from "./account"
import * as store from "./store"
import { captureRegion, saveShot, shareShot, type AskHost, type BrowserHost } from "./shots"
import {
  guestForWindow,
  hideDevTools,
  noteVisit,
  openViews,
  placeTools,
  registerGuest,
  showDevTools,
  toolsOpen,
  waitForGuest,
  type Guest,
} from "./browser"
import * as git from "./git"
import * as conversations from "./conversations"
import * as attachments from "./attachments"
import * as importing from "./importing"
import * as sharing from "./sharing"
import * as commitMessage from "./commitmessage"

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

// browserHost est ce que le serveur MCP ne peut pas savoir tout seul : où est
// le projet de cette fenêtre (pour sa liste d'origines) et comment demander au
// rendu d'ouvrir l'onglet. Il vit ici parce que c'est ici que les fenêtres et
// les projets se connaissent.
export const browserHost: BrowserHost = {
  open: async (win, view = "") => {
    // Une vue nommée qui existe : on la révèle à la personne et on la rend.
    // Sans ça, l'agent piloterait une page que personne ne regarde.
    const named = view && view !== "new" ? viewNamed(view) : null
    if (named) {
      win.webContents.send("browser:open", { view })
      return named
    }
    if (view !== "new") {
      const already = guestForWindow(win.id)
      if (already) {
        win.webContents.send("browser:open", { view: "" })
        return already
      }
    }
    win.webContents.send("browser:open", { view })
    return waitForGuest(win.id, 10_000, view === "new")
  },
  projectDir: (win) => workspaces.get(win)?.root ?? null,
}

function viewNamed(view: string): Guest | null {
  return openViews().find((g) => g.view === view) ?? null
}

// askHost : la question de permission, posée à la personne.
//
// Elle arrive par le serveur MCP de l'application, sans conversation attachée :
// c'est la CLI qui la pose, au milieu d'un tour. Elle part donc vers la fenêtre
// au premier plan — celle que la personne regarde en la posant — et la réponse
// revient par un canal, avec l'identifiant de la demande.
//
// Elle attend, longtemps : quelqu'un doit avoir le temps de lire. Mais pas
// indéfiniment — un tour laissé en plan tiendrait un processus CLI ouvert, et
// la personne n'aurait plus rien à cliquer.
const pendingAsks = new Map<string, (answer: { allow: boolean; message?: string }) => void>()
const ASK_PATIENCE_MS = 10 * 60 * 1000

export const askHost: AskHost = async (request) => {
  const [win] = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isFocused())
  const target = win ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!target) return { allow: false, message: "Zyvro Studio is not open" }

  const id = randomUUID()
  target.webContents.send("agent:permission", { id, tool: request.tool, input: request.input })

  return await new Promise((resolve) => {
    const settle = (answer: { allow: boolean; message?: string }) => {
      clearTimeout(timer)
      pendingAsks.delete(id)
      resolve(answer)
    }
    pendingAsks.set(id, settle)
    const timer = setTimeout(
      () => settle({ allow: false, message: "nobody answered — ask again, or change what the agent may do" }),
      ASK_PATIENCE_MS
    )
  })
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

export function registerIpc(onRecents?: () => void): void {
  onRecentsChanged = onRecents ?? null

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

  // La capture d'une zone, demandée par le bouton de la barre du bas. La
  // fenêtre est celle qui a posé la question : c'est celle que la personne
  // regarde, et elle ne peut pas en viser une autre depuis son propre rendu.
  // La capture, puis ce qu'on en fait — en trois temps, parce que la fenêtre
  // qui s'ouvre entre les deux pose une vraie question : garder, ou publier.
  //
  // Les octets restent ici entre les deux : les renvoyer au rendu puis les
  // reprendre les ferait traverser deux fois le pont pour rien, et une capture
  // d'écran d'un grand moniteur pèse quelques mégaoctets.
  let pending: { png: Buffer; label: string } | null = null

  ipcMain.handle("shots:capture", async (event, rect, label?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const png = await captureRegion(win ?? undefined, rect)
    pending = { png, label: typeof label === "string" ? label : "" }
    // L'aperçu part en data URL : c'est une image que le rendu doit afficher,
    // pas un fichier qu'il doit lire.
    return { preview: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length }
  })

  ipcMain.handle("shots:save", async () => {
    if (!pending) throw new Error("nothing captured")
    // Dans les téléchargements : c'est le dossier où l'on va chercher ce qu'on
    // vient de récupérer, et il est déjà dans la barre latérale de tout le
    // monde.
    return saveShot(pending.png, {
      dir: app.getPath("downloads"),
      label: pending.label,
      open: (file) => void shell.openPath(file),
    })
  })

  ipcMain.handle("shots:share", async () => {
    if (!pending) throw new Error("nothing captured")
    return shareShot(pending.png, pending.label, (pathname, init) =>
      authorized(pathname, init as unknown as RequestInit)
    )
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

  // ---------- le navigateur de test ----------
  //
  // Le rendu monte la <webview> et annonce ici l'identifiant de son contenu :
  // c'est la seule façon pour le processus principal de tenir la vue, et c'est
  // le rendu qui la possède. Rien n'est accepté d'une autre fenêtre — l'identité
  // vient de l'expéditeur, comme partout ailleurs.
  ipcMain.handle("browser:attach", async (event, contentsId: number, view: string) => {
    const { win } = requireWorkspace(event)
    const guest = webContents.fromId(Number(contentsId))
    if (!guest || guest.getType() !== "webview") throw new Error("that is not a browser view")
    registerGuest(guest, win.id, String(view ?? ""))
    return true
  })

  // Ce que la personne a ouvert elle-même : un accord explicite, pour cette
  // origine et pour cette session. C'est l'une des trois portes de la politique.
  // Les outils se dessinent dans une vue posée sur la fenêtre, à l'emplacement
  // que le rendu leur réserve sous la page. C'est donc le rendu qui mesure, et
  // il le refait à chaque changement de taille — y compris quand l'onglet
  // disparaît, ce qui mesure zéro et fait disparaître la vue avec lui.
  ipcMain.handle(
    "browser:devtools",
    async (event, contentsId: number, open: boolean, bounds: Electron.Rectangle | null) => {
      requireWorkspace(event)
      const guest = openViews().find((g) => g.id === Number(contentsId))
      if (!guest) throw new Error("no such browser view")
      if (open) showDevTools(guest, bounds ?? null)
      else hideDevTools(guest)
      return toolsOpen(guest)
    }
  )

  ipcMain.handle("browser:devtools-bounds", async (event, contentsId: number, bounds: Electron.Rectangle | null) => {
    requireWorkspace(event)
    const guest = openViews().find((g) => g.id === Number(contentsId))
    if (guest) placeTools(guest, bounds ?? null)
    return true
  })

  ipcMain.handle("browser:visited", async (event, contentsId: number, url: string) => {
    requireWorkspace(event)
    noteVisit(Number(contentsId), String(url))
    return true
  })

  // La réponse de la personne à une demande de permission.
  ipcMain.handle("agent:permission-answer", async (event, id: string, allow: boolean) => {
    requireWorkspace(event)
    const settle = pendingAsks.get(String(id))
    if (!settle) return false
    settle({ allow: allow === true, message: allow === true ? undefined : "you said no" })
    return true
  })

  ipcMain.handle("terminal:create", async (event, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    // Le démon du projet part avec le shell : un agent lancé à la main dedans
    // doit pouvoir joindre les mêmes serveurs MCP que celui du panneau.
    return ws.terminals.create(event.sender, requireRoot(ws), cols || 80, rows || 24, {
      daemonOrigin: ws.daemon.current?.origin,
      daemonToken: ws.daemon.current?.token,
    })
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
    async (
      event,
      kind: AgentKind,
      prompt: string,
      ctx: Partial<AgentContext>,
      conversationId: string,
      model: string | null,
      images: string[]
    ) => {
      const { ws } = requireWorkspace(event)
      const root = requireRoot(ws)
      return ws.agent.send(
        event.sender,
        kind === "codex" ? "codex" : "claude",
        String(prompt),
        {
          projectDir: root,
          workflows: Array.isArray(ctx?.workflows) ? ctx.workflows : [],
          daemonOrigin: ws.daemon.current?.origin,
          daemonToken: ws.daemon.current?.token,
          // Ce que l'agent a le droit de faire vient du panneau : c'est un
          // choix par conversation, et la personne le voit à côté de son texte.
          // La liste des niveaux vient du module partagé : l'écrire ici une
          // seconde fois, c'est ce qui vient d'arriver — « ask » n'y était pas,
          // et le panneau demandait un mode que le principal remplaçait par le
          // sien sans rien dire.
          permission: PERMISSIONS.includes(ctx?.permission as Permission)
            ? (ctx.permission as Permission)
            : DEFAULT_PERMISSION,
        },
        String(conversationId),
        typeof model === "string" && model.trim() ? model.trim() : null,
        // Only paths this process wrote itself are accepted. The renderer names
        // an attachment by its id; it never hands over a path, so it cannot ask
        // the CLI to read /etc/passwd by calling it an image.
        Array.isArray(images) ? attachments.pathsFor(String(conversationId), images.map(String)) : []
      )
    }
  )

  // ---------- conversations ----------
  //
  // The transcript is stored beside the session id, and both are loaded back
  // when a project reopens. Storing only the id would be worse than storing
  // nothing: the panel would open empty while the agent still remembered every
  // word, which is an assistant nobody can predict.

  ipcMain.handle("agent:conversations", async (event) => {
    const { ws } = requireWorkspace(event)
    const all = await conversations.load(requireRoot(ws))
    // The runner is told what it is expected to resume, so a conversation
    // reopened after a restart carries on rather than starting over.
    for (const conversation of all) ws.agent.resumeAt(conversation.id, conversation.sessionId)
    return all
  })

  ipcMain.handle("agent:remember", async (event, conversation: conversations.Conversation) => {
    const { ws } = requireWorkspace(event)
    return conversations.remember(requireRoot(ws), {
      ...conversation,
      // The id the CLI actually reported wins over whatever the renderer last
      // saw: it is learned from the output stream, and the renderer only hears
      // about it through an event that may still be in flight.
      sessionId: ws.agent.sessionFor(conversation.id) ?? conversation.sessionId ?? null,
    })
  })

  ipcMain.handle("agent:forget", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.resumeAt(String(id), null)
    // The images go with the conversation. That is what keeps this folder from
    // growing forever without a sweeper to write and then forget about.
    await attachments.drop(String(id))
    return conversations.forget(requireRoot(ws), String(id))
  })

  // ---------- images for the agent ----------
  //
  // Both CLIs want a file on disk and neither takes bytes, so whatever is
  // pasted, dropped or picked becomes a file here first. It lives beside the
  // conversation rather than in the project: a screenshot pasted to explain a
  // bug is not part of anybody's repository.

  ipcMain.handle(
    "agent:attach",
    async (_event, conversationId: string, name: string, bytes: Uint8Array) => {
      const kept = await attachments.keep(String(conversationId), String(name ?? ""), new Uint8Array(bytes))
      // The path stays in this process. The renderer gets an id and a name,
      // which is everything a chip needs to draw itself.
      return { id: kept.id, name: kept.name, mime: kept.mime }
    }
  )

  ipcMain.handle("agent:detach", async (_event, conversationId: string, id: string) =>
    attachments.forget(String(conversationId), String(id))
  )

  // The models a CLI offers, read out of its own --help rather than written
  // down here. There is no machine-readable list to ask either of them for, so
  // the choice was between a second list that goes stale and a narrow parse of
  // what the tool states. A parse that finds nothing is not a failure: the
  // picker then offers the default and a box to type a full name in.
  ipcMain.handle("agent:models", async (_event, kind: AgentKind) => {
    const bin = kind === "codex" ? "codex" : "claude"
    return agentModule.aliasesFrom(helpOf(bin))
  })

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

  // The password travels renderer → main and is used to unseal the signing key
  // for the length of one request. It is never written down on this side: the
  // key it opens is, sealed, and that is the only durable thing.
  ipcMain.handle("store:publish-pack", async (event, name: string, password: string) => {
    const { ws } = requireWorkspace(event)
    return store.publishPack(requireRoot(ws), String(name), String(password))
  })

  ipcMain.handle(
    "store:publish-workflow",
    async (event, payload: { id: string; name: string; description: string; graph: unknown }) => {
      requireWorkspace(event)
      return store.publishWorkflow(payload)
    }
  )

  // ---------- Git ----------
  //
  // Every one of these is the open project and nothing else: the root comes
  // from the workspace, never from the renderer, so a window cannot be talked
  // into running git somewhere else. The paths inside are checked against that
  // root by git.ts itself.

  ipcMain.handle("git:status", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.status(requireRoot(ws))
  })

  ipcMain.handle("git:init", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.init(requireRoot(ws))
  })

  ipcMain.handle("git:stage", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return git.stage(requireRoot(ws), paths.map(String))
  })

  ipcMain.handle("git:unstage", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return git.unstage(requireRoot(ws), paths.map(String))
  })

  ipcMain.handle("git:discard", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return git.discard(requireRoot(ws), paths.map(String))
  })

  ipcMain.handle("git:commit", async (event, message: string, options: git.CommitOptions) => {
    const { ws } = requireWorkspace(event)
    return git.commit(requireRoot(ws), String(message), {
      amend: Boolean(options?.amend),
      stageAll: Boolean(options?.stageAll),
    })
  })

  ipcMain.handle("git:diff", async (event, relative: string, staged: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.diff(requireRoot(ws), String(relative), Boolean(staged))
  })

  ipcMain.handle("git:file-at", async (event, relative: string, revision: string) => {
    const { ws } = requireWorkspace(event)
    return git.fileAt(requireRoot(ws), String(relative), String(revision))
  })

  ipcMain.handle("git:log", async (event, limit?: number) => {
    const { ws } = requireWorkspace(event)
    return git.log(requireRoot(ws), Number(limit) || 50)
  })

  ipcMain.handle("git:branches", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.branches(requireRoot(ws))
  })

  ipcMain.handle("git:checkout", async (event, branch: string) => {
    const { ws } = requireWorkspace(event)
    return git.checkout(requireRoot(ws), String(branch))
  })

  ipcMain.handle("git:create-branch", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return git.createBranch(requireRoot(ws), String(name))
  })

  ipcMain.handle("git:fetch", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.fetch(requireRoot(ws))
  })

  ipcMain.handle("git:pull", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.pull(requireRoot(ws))
  })

  ipcMain.handle("git:push", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.push(requireRoot(ws))
  })

  ipcMain.handle("git:push-to", async (event, remote: string, setUpstream: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.pushTo(requireRoot(ws), String(remote), Boolean(setUpstream))
  })

  ipcMain.handle("git:push-tags", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.pushTags(requireRoot(ws))
  })

  ipcMain.handle("git:remotes", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.remoteList(requireRoot(ws))
  })

  ipcMain.handle("git:add-remote", async (event, name: string, url: string) => {
    const { ws } = requireWorkspace(event)
    return git.addRemote(requireRoot(ws), String(name), String(url))
  })

  ipcMain.handle("git:remove-remote", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return git.removeRemote(requireRoot(ws), String(name))
  })

  ipcMain.handle("git:stash-list", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.stashList(requireRoot(ws))
  })

  ipcMain.handle("git:stash", async (event, message: string, includeUntracked: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.stash(requireRoot(ws), String(message ?? ""), Boolean(includeUntracked))
  })

  ipcMain.handle("git:stash-pop", async (event, index: number) => {
    const { ws } = requireWorkspace(event)
    return git.stashPop(requireRoot(ws), Number(index))
  })

  ipcMain.handle("git:stash-apply", async (event, index: number) => {
    const { ws } = requireWorkspace(event)
    return git.stashApply(requireRoot(ws), Number(index))
  })

  ipcMain.handle("git:stash-drop", async (event, index: number) => {
    const { ws } = requireWorkspace(event)
    return git.stashDrop(requireRoot(ws), Number(index))
  })

  ipcMain.handle("git:tags", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.tags(requireRoot(ws))
  })

  ipcMain.handle("git:create-tag", async (event, name: string, message: string) => {
    const { ws } = requireWorkspace(event)
    return git.createTag(requireRoot(ws), String(name), String(message ?? ""))
  })

  ipcMain.handle("git:delete-tag", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return git.deleteTag(requireRoot(ws), String(name))
  })

  ipcMain.handle("git:rename-branch", async (event, from: string, to: string) => {
    const { ws } = requireWorkspace(event)
    return git.renameBranch(requireRoot(ws), String(from), String(to))
  })

  ipcMain.handle("git:delete-branch", async (event, name: string, force: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.deleteBranch(requireRoot(ws), String(name), Boolean(force))
  })

  ipcMain.handle("git:output", async () => git.output())

  ipcMain.handle("git:agent", async () => commitMessage.availableAgent())

  ipcMain.handle("git:suggest-message", async (event) => {
    const { ws } = requireWorkspace(event)
    return commitMessage.suggest(requireRoot(ws))
  })

  // Clone is the one that has no project yet: the person picks where it lands
  // through a real directory dialog, so nothing the renderer says decides that.
  ipcMain.handle("git:clone", async (event, url: string) => {
    const { win } = requireWorkspace(event)
    const chosen = await dialog.showOpenDialog(win, {
      title: "Where should the repository be cloned?",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Clone here",
    })
    if (chosen.canceled || chosen.filePaths.length === 0) return null
    return git.clone(chosen.filePaths[0], String(url))
  })

  // ---------- importing from another project ----------
  //
  // A workflow is a JSON file in a folder, so the thing you want to copy is
  // already sitting in whatever repository it belongs to. What makes it awkward
  // by hand is knowing that, finding it, and getting the graph out.
  //
  // The folder is chosen through a real dialog: a renderer that could name a
  // directory to read could name any directory.
  ipcMain.handle("workflows:choose-source", async (event) => {
    const { win } = requireWorkspace(event)
    return importing.choose(win)
  })

  // ---------- the account's own workflows ----------
  //
  // A workflow in a project is a file; on the account it is a row. These two
  // are the crossing between them: one sends a copy up and hands back a link,
  // the other reads back what is already there.

  ipcMain.handle(
    "workflows:share",
    async (_event, payload: { name: string; description: string; graph: unknown }) =>
      sharing.share({
        name: String(payload?.name ?? ""),
        description: String(payload?.description ?? ""),
        graph: payload?.graph ?? {},
      })
  )

  ipcMain.handle("workflows:mine", async () => sharing.mine())

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
