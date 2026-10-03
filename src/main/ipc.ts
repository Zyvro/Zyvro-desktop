import { app, BrowserWindow, dialog, ipcMain, Menu, shell, webContents } from "electron"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { Daemon, DaemonError, homeWorkspace, type DaemonInfo } from "./daemon"
import { Terminals } from "./terminal"
import { AgentRunner, type AgentContext, type AgentKind } from "./agent"
import { AGENT_KINDS, harness, interactiveCommand, isAgentKind } from "../shared/harness"
import { isAbsolutePath } from "../shared/external"
import { cleanSynthesis, isSynthesisMode, synthesisPrompt } from "../shared/synthesize"
import { aimFor, aimableModels } from "./aim"
import { known as knownCommands } from "./commands"
import { DEFAULT_PERMISSION, PERMISSIONS, type Permission } from "../shared/permission"
import * as agentModule from "./agent"
import { adoptHomeBins, helpOf, installed, locate, outputOf } from "./cli"
import fs from "node:fs/promises"
import * as files from "./files"
import * as textSearch from "./search"
import * as persistent from "./persistent"
import { createWatcher, type Watcher } from "./watch"
import { forgetRecents, loadRecents, recentFiles, rememberFile, rememberRecent } from "./recents"
import { choose as chooseShell, shells as machineShells } from "./shell"
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
import * as mimoInstall from "./mimoinstall"
import { findMenuItem, flattenMenu } from "./menulist"
import * as updater from "./updater"

// One Workspace per window, holding every project folder the person opened in
// that window. Each project keeps its own daemon, file watcher and git repo
// selection so switching does not tear the previous one down — shells and agent
// turns of a background project stay alive. Bundling them means closing a
// window tears everything down together instead of leaking a daemon.
//
// `terminals`, `agent` and `grants` stay on the window: a pty is already filed
// under its birth cwd, conversations are stored per project root, and a file
// dropped into the window is a grant to the window.
class ProjectSlot {
  /**
   * Le dossier que la personne a ouvert, ou null pour le slot d'accueil.
   * C'est lui que l'écran d'accueil regarde.
   */
  project: string | null = null
  /**
   * Un dossier passé au lancement est en train de s'ouvrir.
   *
   * Sans ce drapeau, la fenêtre réclame le moteur de la maison au moment même
   * où ce dossier s'ouvre — mesuré, et c'est une course qui rate une fois sur
   * trois : les deux démarrages se tuaient l'un l'autre, puis celui de la
   * maison écrasait la racine du projet. Ce qui est déjà en route gagne.
   */
  startupPending = false
  /**
   * Où le moteur, les agents et les shells travaillent : le projet ouvert, ou
   * le dossier d'accueil quand il n'y en a pas.
   */
  root: string | null = null
  /**
   * Le dépôt Git que l'onglet Git regarde : "" pour le projet lui-même, sinon
   * le nom d'un sous-dossier direct qui a son propre `.git`.
   */
  gitRepo = ""
  readonly daemon = new Daemon()
  watcher: Watcher | null = null

  async dispose(): Promise<void> {
    this.watcher?.dispose()
    this.watcher = null
    await this.daemon.stop()
  }
}

export type OpenProjectRef = { project: string; name: string }

export class Workspace {
  /** Le slot d'accueil : le moteur de la maison, quand aucun projet n'est actif. */
  private readonly home = new ProjectSlot()
  /** Un slot par projet ouvert, indexé par son chemin absolu. */
  private readonly slots = new Map<string, ProjectSlot>()
  private activeSlot: ProjectSlot
  private activeKey: string | null = null

  readonly terminals = new Terminals()
  readonly agent = new AgentRunner()
  /**
   * Les fichiers hors du projet que cette fenêtre peut lire et écrire : ceux
   * qu'on y a lâchés ou choisis par File › Open File…, chemins résolus. Un
   * chemin absolu qui n'est pas ici est refusé — la fenêtre ne nomme pas le
   * disque, elle reçoit ce qu'on lui a donné.
   */
  readonly grants = new Set<string>()

  constructor() {
    this.activeSlot = this.home
    this.wireDaemon(this.home)
  }

  // Les accesseurs délégués : le reste de ce fichier parle encore de
  // `ws.project`, `ws.daemon`, etc., et ne doit pas savoir qu'il y a plusieurs
  // slots. C'est le projet actif qui répond.
  get project(): string | null {
    return this.activeSlot.project
  }
  set project(value: string | null) {
    this.activeSlot.project = value
  }
  get root(): string | null {
    return this.activeSlot.root
  }
  set root(value: string | null) {
    this.activeSlot.root = value
  }
  get gitRepo(): string {
    return this.activeSlot.gitRepo
  }
  set gitRepo(value: string) {
    this.activeSlot.gitRepo = value
  }
  get startupPending(): boolean {
    return this.activeSlot.startupPending
  }
  set startupPending(value: boolean) {
    this.activeSlot.startupPending = value
  }
  get daemon(): Daemon {
    return this.activeSlot.daemon
  }
  get watcher(): Watcher | null {
    return this.activeSlot.watcher
  }
  set watcher(value: Watcher | null) {
    this.activeSlot.watcher = value
  }

  /** Les projets ouverts, dans l'ordre des onglets. */
  list(): OpenProjectRef[] {
    return [...this.slots.values()]
      .filter((slot) => slot.project !== null)
      .map((slot) => ({ project: slot.project as string, name: path.basename(slot.project as string) }))
  }

  /** Le projet actif, ou null quand c'est le dossier d'accueil. */
  current(): OpenProjectRef | null {
    const project = this.activeSlot.project
    return project ? { project, name: path.basename(project) } : null
  }

  private wireDaemon(slot: ProjectSlot): void {
    slot.daemon.onStopped((reason) => {
      // Seul le slot actif prévient la fenêtre : un moteur de projet en
      // arrière-plan qui meurt ne doit pas effacer le port affiché pour un
      // autre. Le prochain basculement verra l'absence de `current`.
      if (slot !== this.activeSlot) return
      for (const win of BrowserWindow.getAllWindows()) {
        // `workspaces.get` et non `workspaceFor` : ne pas fabriquer un plan de
        // travail pour une fenêtre qui n'en a pas encore, juste pour comparer.
        if (workspaces.get(win) === this && !win.isDestroyed()) win.webContents.send("engine:stopped", reason)
      }
    })
  }

  /**
   * Prendre ou créer le slot d'un projet, et le rendre actif.
   * Le slot d'accueil reste vivant : les fournisseurs y sont joignables.
   */
  activate(dir: string): ProjectSlot {
    let slot = this.slots.get(dir)
    if (!slot) {
      slot = new ProjectSlot()
      this.slots.set(dir, slot)
      this.wireDaemon(slot)
    }
    this.activeSlot = slot
    this.activeKey = dir
    return slot
  }

  /** Basculer vers un projet déjà ouvert. Rend false s'il ne l'est pas. */
  switchTo(dir: string): boolean {
    const slot = this.slots.get(dir)
    if (!slot) return false
    this.activeSlot = slot
    this.activeKey = dir
    return true
  }

  /** Revenir au dossier d'accueil (aucun projet actif). */
  activateHome(): void {
    this.activeSlot = this.home
    this.activeKey = null
  }

  /**
   * Fermer un projet : son moteur, sa surveillance — et ses shells, qui
   * étaient les siens. Les autres projets de la fenêtre continuent.
   */
  async closeProject(dir: string): Promise<void> {
    const slot = this.slots.get(dir)
    if (!slot) return
    this.slots.delete(dir)
    // Les shells nés dans ce projet partent avec lui, défilement gardé sous
    // son nom pour qu'une réouverture le retrouve.
    this.terminals.disposeProject(dir)
    await slot.dispose()
    if (this.activeSlot === slot) {
      const reste = this.slots.keys().next()
      if (!reste.done) {
        const next = this.slots.get(reste.value)
        if (next) {
          this.activeSlot = next
          this.activeKey = reste.value
          return
        }
      }
      this.activateHome()
    }
  }

  async dispose(): Promise<void> {
    this.agent.cancelAll()
    // Chaque projet garde le défilement de ses shells sous son nom, pour qu'une
    // réouverture le retrouve — même si plusieurs projets étaient ouverts.
    for (const slot of this.slots.values()) {
      if (slot.root) this.terminals.disposeProject(slot.root)
      await slot.dispose()
    }
    this.slots.clear()
    if (this.home.root) this.terminals.disposeProject(this.home.root)
    // Le balayage final : ce qui reste (la maison, un shell orphelin).
    await this.terminals.disposeAll(this.root ?? undefined)
    await this.home.dispose()
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
    // Le moteur d'un projet peut mourir sans prévenir : chaque slot le signale
    // à sa fenêtre (voir Workspace.wireDaemon). Ici on ne fait que lier le
    // plan de travail à la fenêtre.
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

// requireRoot rend l'endroit où l'on travaille. Il ne lève plus dès qu'aucun
// projet n'est ouvert : il y a toujours un dossier, celui d'accueil à défaut
// d'un autre. Ce qui lève, c'est un moteur qui n'a pas démarré du tout.
function requireRoot(ws: Workspace): string {
  if (!ws.root) throw new Error("The local engine is not running.")
  return ws.root
}

// requireGitRoot rend le dossier du dépôt choisi dans l'onglet Git. Le nom
// vient de la fenêtre mais il a été vérifié à la sélection (`git:select-repo`) :
// un seul segment, sous la racine, avec un `.git`. Il est revérifié ici parce
// que le dossier a pu disparaître depuis, et qu'on retombe alors sur le projet
// plutôt que de lancer git dans le vide.
async function requireGitRoot(ws: Workspace): Promise<string> {
  const root = requireRoot(ws)
  if (!ws.gitRepo) return root
  if (git.isRepositoryName(ws.gitRepo) && (await git.hasOwnRepository(path.join(root, ws.gitRepo)))) {
    return path.join(root, ws.gitRepo)
  }
  ws.gitRepo = ""
  return root
}

// gitOwnerOf rend le dépôt qui tient un fichier nommé depuis la racine du
// projet, et le chemin du fichier dans ce dépôt.
//
// Pour ce que l'éditeur demande à git — la marge, la Timeline, le diff d'un
// commit — le chemin est celui de l'arbre, relatif au projet, et non au dépôt
// choisi dans l'onglet Git. Un fichier de `Zyvro-backend/` appartient au dépôt
// `Zyvro-backend`, quel que soit celui qu'on regarde dans l'onglet.
async function gitOwnerOf(ws: Workspace, relative: string): Promise<{ root: string; relative: string }> {
  const root = requireRoot(ws)
  const clean = relative.replace(/\\/g, "/")
  const cut = clean.indexOf("/")
  if (cut > 0) {
    const first = clean.slice(0, cut)
    if (git.isRepositoryName(first) && (await git.hasOwnRepository(path.join(root, first)))) {
      return { root: path.join(root, first), relative: clean.slice(cut + 1) }
    }
  }
  return { root, relative }
}

// ensureEngine garantit qu'une fenêtre a un moteur, avec ou sans projet.
//
// C'est le point unique où « aucun projet » cesse d'être un cas particulier :
// au lieu de répondre « pas de projet » à chaque appel, on ouvre le dossier
// d'accueil et tout le reste du code continue de parler à un moteur comme
// d'habitude.
async function ensureEngine(ws: Workspace): Promise<DaemonInfo | null> {
  if (ws.daemon.current) return ws.daemon.current
  // Un dossier est déjà en route : c'est lui qui aura le moteur, et en
  // démarrer un deuxième ne ferait que se battre avec le sien.
  if (ws.startupPending) return null
  const home = homeWorkspace()
  const info = await ws.daemon.start(home)
  // Et une dernière fois après l'attente : un projet a pu s'ouvrir pendant ce
  // temps, auquel cas la racine est la sienne, pas la nôtre.
  if (!ws.project) ws.root = home
  return info
}

// Un fichier hors du projet : seulement s'il a été accordé à cette fenêtre
// (files.grantedPath, files.openOutside).
const accorde = (ws: Workspace, p: string): string | null => files.grantedPath(ws.grants, p)
const ouvrirDehors = (ws: Workspace, paths: string[]): Promise<string[]> => files.openOutside(ws.grants, ws.project, paths)

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

  // Ouvrir un projet : l'ajouter aux onglets de la fenêtre s'il n'y est pas
  // déjà, puis le rendre actif. Les autres projets ouverts restent vivants —
  // c'est tout l'intérêt des onglets de projet.
  ipcMain.handle("project:open", async (event, dir: string): Promise<OpenResult> => {
    const { win, ws } = requireWorkspace(event)
    if (typeof dir !== "string" || !dir) throw new Error("A project path is required.")
    // Déjà ouvert : on bascule, sans redémarrer son moteur ni toucher à ses
    // shells. C'est ce que fait le clic sur un onglet de projet.
    if (ws.switchTo(dir) && ws.daemon.current) {
      ws.project = dir
      ws.root = dir
      ws.startupPending = false
      win.setTitle(`${path.basename(dir)} — Zyvro Studio`)
      win.setRepresentedFilename?.(dir)
      return { project: dir, name: path.basename(dir), daemon: ws.daemon.current }
    }
    const slot = ws.activate(dir)
    try {
      const daemon = await slot.daemon.start(dir)
      // Les dossiers surveillés de ce slot : un arbre neuf, rien à garder.
      slot.watcher?.dispose()
      slot.watcher = null
      slot.root = dir
      slot.project = dir
      slot.gitRepo = ""
      win.setTitle(`${path.basename(dir)} — Zyvro Studio`)
      win.setRepresentedFilename?.(dir)
      // Only a folder that opened successfully is worth offering again.
      rememberRecent(dir)
      onRecentsChanged?.()
      slot.startupPending = false
      return { project: dir, name: path.basename(dir), daemon }
    } catch (err) {
      slot.root = null
      slot.project = null
      slot.startupPending = false
      // Un échec ne doit pas laisser un onglet fantôme.
      void ws.closeProject(dir)
      if (err instanceof DaemonError) {
        throw new Error(err.detail ? `${err.message}\n\n${err.detail}` : err.message)
      }
      throw err
    }
  })

  // Basculer vers un projet déjà ouvert, sans rien fermer ailleurs.
  ipcMain.handle("project:switch", async (event, dir: string): Promise<OpenResult | null> => {
    const { win, ws } = requireWorkspace(event)
    if (typeof dir !== "string" || !dir) throw new Error("A project path is required.")
    if (!ws.switchTo(dir)) return null
    const project = ws.project
    const daemon = ws.daemon.current
    if (!project || !daemon) return null
    win.setTitle(`${path.basename(project)} — Zyvro Studio`)
    win.setRepresentedFilename?.(project)
    return { project, name: path.basename(project), daemon }
  })

  // Un nouveau Zyvro dans cette fenêtre : l'écran d'accueil, sur le moteur de
  // la maison, sans fermer ni arrêter les projets ouverts — ils restent dans la
  // barre de titre et un clic les reprend. C'est ce que fait le « + » : ouvrir
  // un Zyvro neuf d'où l'on crée, ouvre ou clone, plutôt qu'un sélecteur de
  // dossier qui supposait qu'on sait déjà lequel.
  ipcMain.handle("project:home", async (event) => {
    const { win, ws } = requireWorkspace(event)
    ws.activateHome()
    const daemon = await ensureEngine(ws)
    win.setTitle("Zyvro Studio")
    win.setRepresentedFilename?.("")
    return { root: ws.root, daemon }
  })

  // Les projets ouverts dans cette fenêtre, pour la barre de titre.
  ipcMain.handle("project:list", async (event) => {
    const { ws } = requireWorkspace(event)
    return { projects: ws.list(), active: ws.current() }
  })

  ipcMain.handle("project:current", async (event) => {
    const { ws } = requireWorkspace(event)
    if (!ws.project || !ws.daemon.current) return null
    return { project: ws.project, name: path.basename(ws.project), daemon: ws.daemon.current }
  })

  // Un moteur, avec ou sans projet. C'est ce que la fenêtre demande au
  // démarrage quand personne n'a rien ouvert : les fournisseurs sont globaux,
  // les agents le sont aussi tant qu'aucun projet ne l'est, et les uns comme
  // les autres passent par le moteur.
  ipcMain.handle("engine:ensure", async (event) => {
    const { ws } = requireWorkspace(event)
    const daemon = await ensureEngine(ws)
    // `daemon: null` veut dire « pas maintenant, un dossier est déjà en
    // route » : la fenêtre n'a rien à faire, l'ouverture lui donnera l'adresse.
    return { project: ws.project, root: ws.root, daemon }
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

  // Le fichier qu'on regarde, retenu pour Open Recent et ⌘P. Seulement ceux du
  // projet : un fichier lâché d'ailleurs n'a pas de place dans sa liste.
  ipcMain.handle("recents:file-opened", async (event, rel: string) => {
    const { ws } = requireWorkspace(event)
    if (!ws.project || typeof rel !== "string" || !rel || isAbsolutePath(rel) || rel.split("/").includes("..")) return false
    if (rememberFile(ws.project, rel)) onRecentsChanged?.()
    return true
  })
  ipcMain.handle("recents:files", async (event) => {
    const { ws } = requireWorkspace(event)
    return ws.project ? recentFiles(ws.project) : []
  })

  // Le shell du panneau. Une préférence de machine, comme la liste des projets
  // récents : elle ne dépend d'aucun projet ouvert, donc elle n'en réclame pas.
  ipcMain.handle("shell:list", async () => machineShells())

  // `choose` revérifie ce qu'on lui donne contre ce que la machine offre. Le
  // rendu n'envoie ici qu'un fichier qu'il a lu de `shell:list`, mais c'est la
  // règle partout ici : ce qui vient de la fenêtre est du texte jusqu'à preuve
  // du contraire.
  ipcMain.handle("shell:choose", async (_event, file: string | null) => {
    chooseShell(typeof file === "string" && file !== "" ? file : null)
    return machineShells()
  })

  ipcMain.handle("project:forget-recents", async () => {
    const recents = forgetRecents()
    onRecentsChanged?.()
    return recents
  })

  // Fermer le projet actif. Les autres onglets de projet continuent ; s'il n'y
  // en a plus, on revient au moteur de la maison — les fournisseurs, les agents
  // et les shells restent utilisables, et c'est la seule lecture cohérente de
  // « les agents sont globaux quand aucun projet n'est ouvert ».
  ipcMain.handle("project:close", async (event) => {
    const { ws } = requireWorkspace(event)
    const partant = ws.project
    if (partant) await ws.closeProject(partant)
    // Encore un projet ouvert : on reste dessus, son moteur est déjà le bon.
    if (ws.project && ws.daemon.current) {
      return {
        root: ws.root,
        daemon: ws.daemon.current,
        projects: ws.list(),
        active: ws.current(),
      }
    }
    // Plus aucun projet : le moteur de la maison, comme au premier lancement.
    if (!ws.root) ws.activateHome()
    const daemon = await ensureEngine(ws)
    return {
      root: ws.root,
      daemon,
      projects: ws.list(),
      active: ws.current(),
    }
  })

  // The graph editor asks for this when someone clicks Browse on a Read File
  // or Write File node. It returns a path relative to the project, because that
  // is what goes into the workflow: an absolute path would break the moment the
  // workflow was opened on another machine, and workflows are meant to be
  // committed and shared.
  ipcMain.handle(
    "files:pick",
    async (event, request: { save?: boolean; directory?: boolean; title?: string; current?: string }) => {
      const { win, ws } = requireWorkspace(event)
      const root = await fs.realpath(requireRoot(ws))
      // A folder is its own starting point; a file's is the folder holding it.
      const startIn = request?.current
        ? request?.directory
          ? path.resolve(root, request.current)
          : path.resolve(root, path.dirname(request.current))
        : root

      const chosen = request?.save
        ? await dialog.showSaveDialog(win, {
            title: request?.title || "Write to",
            defaultPath: request.current ? path.resolve(root, request.current) : root,
            buttonLabel: "Use this path",
          })
        : await dialog.showOpenDialog(win, {
            title: request?.title || (request?.directory ? "Choose a folder" : "Choose a file"),
            defaultPath: startIn,
            // A batch runs over a folder, and typing the path of one is the
            // kind of thing that is wrong by a character and comes back as
            // "no such folder". Same dialog, same relative-path answer, same
            // refusal when the pick lands outside the project.
            properties: [request?.directory ? "openDirectory" : "openFile"],
            buttonLabel: request?.directory ? "Use this folder" : "Use this file",
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

  // L'arbre dit ce qu'il a ouvert et ce qu'il a replié. Rien d'autre n'est
  // surveillé : un dossier replié n'est pas affiché, et le surveiller serait
  // payer pour une information qu'on jette — un `node_modules` surveillé
  // récursivement, c'est des dizaines de milliers de descripteurs sur macOS.
  ipcMain.handle("files:watch", async (event, relative: string) => {
    const { win, ws } = requireWorkspace(event)
    requireRoot(ws)
    if (!ws.watcher) {
      ws.watcher = createWatcher(
        () => ws.root,
        (dir) => {
          if (!win.isDestroyed()) win.webContents.send("files:changed", { dir })
        }
      )
    }
    await ws.watcher.watch(relative ?? ".")
    return true
  })

  ipcMain.handle("files:unwatch", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    ws.watcher?.unwatch(relative ?? ".")
    return true
  })

  ipcMain.handle("files:read", async (event, relative: string, force?: boolean) => {
    const { ws } = requireWorkspace(event)
    const dehors = accorde(ws, relative)
    if (dehors) return files.readAt(dehors, relative, force === true)
    return files.readFile(requireRoot(ws), relative, force === true)
  })

  ipcMain.handle("files:write", async (event, relative: string, text: string) => {
    const { ws } = requireWorkspace(event)
    const dehors = accorde(ws, relative)
    if (dehors) await files.writeAt(dehors, String(text))
    else await files.writeFile(requireRoot(ws), relative, String(text))
    return true
  })

  // Ouvrir des fichiers d'ailleurs : lâchés sur la fenêtre, ou choisis. Rend le
  // chemin de l'onglet de chacun — relatif s'il est dans le projet, absolu
  // sinon, et alors accordé à cette fenêtre.
  ipcMain.handle("files:open-external", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return ouvrirDehors(ws, Array.isArray(paths) ? paths : [])
  })
  ipcMain.handle("files:choose-external", async (event) => {
    const { win, ws } = requireWorkspace(event)
    const r = await dialog.showOpenDialog(win, {
      title: "Open a file",
      properties: ["openFile", "multiSelections"],
    })
    if (r.canceled) return []
    return ouvrirDehors(ws, r.filePaths)
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

  // Coller ce qu'on a copié ou coupé. Rend le chemin retenu : quand le nom
  // était pris, ce n'est pas celui qu'on a demandé, et l'appelant doit savoir
  // lequel relire.
  ipcMain.handle("files:paste", async (event, from: string, intoDir: string, mode: "copy" | "move") => {
    const { ws } = requireWorkspace(event)
    return files.pasteEntry(requireRoot(ws), from, intoDir, mode === "move" ? "move" : "copy")
  })

  // Ce qu'on a lâché sur l'arbre depuis le Finder, copié dans un dossier du
  // projet. Les chemins viennent du pont, qui les a tirés des `File` du dépôt
  // — voir `importEntries` pour pourquoi c'est lui et pas le rendu.
  ipcMain.handle("files:import", async (event, sources: string[], intoDir: string) => {
    const { ws } = requireWorkspace(event)
    const list = Array.isArray(sources) ? sources.filter((s) => typeof s === "string") : []
    return files.importEntries(requireRoot(ws), list, String(intoDir ?? ""))
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

  // ---------- chercher, remplacer ----------
  //
  // Le remplacement passe par le même portail que tout le reste : un chemin
  // vient du rendu, donc il est vérifié contre le dossier ouvert avant qu'on y
  // écrive — même quand il sort de notre propre recherche.
  // Les mises à jour. Ce qui a été proposé est gardé ici : la fenêtre dit
  // « télécharge », pas « télécharge cette adresse » — elle ne choisit ni ce
  // qu'on télécharge ni ce qu'on exécute.
  let proposee: updater.UpdateInfo | null = null
  let telecharge: string | null = null
  ipcMain.handle("update:check", async () => {
    proposee = await updater.checkForUpdate()
    return proposee
  })
  ipcMain.handle("update:download", async (event) => {
    if (!proposee) throw new Error("There is no update to download.")
    const r = await updater.downloadUpdate(proposee, event.sender)
    telecharge = r.file
    return r
  })
  ipcMain.handle("update:install", async () => {
    if (!telecharge) throw new Error("Download the update first.")
    if (!proposee) throw new Error("There is no update to install.")
    return updater.installUpdate(telecharge, proposee)
  })

  // La palette de commandes lit le menu, et passe par lui pour agir : une
  // seule liste, et chaque commande fait exactement ce que fait son entrée de
  // menu, rôles d'Electron compris (zoom, plein écran, outils).
  ipcMain.handle("menu:list", async () => flattenMenu(Menu.getApplicationMenu()))
  ipcMain.handle("menu:run", async (event, id: string) => {
    const { win } = requireWorkspace(event)
    const item = findMenuItem(Menu.getApplicationMenu(), String(id ?? ""))
    if (!item) return false
    item.click(undefined, win, win.webContents)
    return true
  })

  ipcMain.handle("files:exist", async (event, relatives: string[]) => {
    const { ws } = requireWorkspace(event)
    return files.existingFiles(requireRoot(ws), Array.isArray(relatives) ? relatives : [])
  })

  // Tous les chemins du projet, pour Quick Open.
  ipcMain.handle("files:all", async (event) => {
    const { ws } = requireWorkspace(event)
    return textSearch.listFiles(requireRoot(ws))
  })

  ipcMain.handle("search:find", async (event, query: textSearch.SearchQuery) => {
    const { ws } = requireWorkspace(event)
    return textSearch.search(requireRoot(ws), query)
  })

  ipcMain.handle(
    "search:replace",
    async (
      event,
      query: textSearch.SearchQuery,
      replacement: string,
      targets: textSearch.ReplaceTarget[] | null
    ) => {
      const { ws } = requireWorkspace(event)
      return textSearch.replaceAll(
        requireRoot(ws),
        query,
        String(replacement ?? ""),
        Array.isArray(targets) && targets.length > 0 ? targets : undefined
      )
    }
  )

  ipcMain.handle("terminal:create", async (event, cols: number, rows: number, cwd?: string, history?: string) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)

    // Rouvrir un shell là où il était, et nulle part ailleurs.
    //
    // Le rendu ne nomme pas un dossier : il renvoie une valeur que le principal
    // lui a donnée, et le principal la revérifie. C'est la même règle que
    // partout ici — un chemin qui vient de la fenêtre est du texte jusqu'à
    // preuve du contraire, et « ouvrir un shell ici » deviendrait sinon
    // « ouvrir un shell n'importe où sur la machine ».
    let lieu = root
    if (typeof cwd === "string" && cwd !== "" && cwd !== root) {
      const gardes = await ws.terminals.saved(root)
      if (gardes.some((garde) => garde.cwd === cwd)) lieu = cwd
    }

    // Le démon du projet part avec le shell : un agent lancé à la main dedans
    // doit pouvoir joindre les mêmes serveurs MCP que celui du panneau.
    return ws.terminals.create(
      event.sender,
      lieu,
      cols || 80,
      rows || 24,
      {
        daemonOrigin: ws.daemon.current?.origin,
        daemonToken: ws.daemon.current?.token,
      },
      { seed: typeof history === "string" ? history : "" }
    )
  })

  // Reprendre les shells d'un projet après un rechargement du rendu.
  //
  // Les ptys sont des enfants du processus principal : une page qui recharge ne
  // les tue pas, elle les oublie. Ils continuaient donc d'écrire dans le vide,
  // injoignables jusqu'à la fermeture de la fenêtre, pendant que la page neuve
  // en ouvrait un de plus à côté.
  // ---- les shells persistants ----------------------------------------------
  //
  // Un shell ordinaire est notre enfant : il meurt avec la fenêtre, mesuré.
  // Celui-ci appartient au démon de `tmux` ou de `screen`, et nous n'en sommes
  // que le client — fermer l'onglet détache, la session continue.

  ipcMain.handle("persistent:available", async () => persistent.manager())

  // Ce que le gestionnaire dit, plus ce que cette fenêtre vient d'attacher.
  //
  // Les deux, parce que `screen -ls` ment pendant une seconde : la socket d'un
  // client qu'on vient de lancer n'existe pas encore quand la commande rend la
  // main, et une session ouverte à l'instant manquait donc à la liste. Le
  // gestionnaire reste la source pour tout ce qui vient d'ailleurs — un
  // `screen` lancé dans un terminal à côté — et nous sommes la source pour ce
  // que nous avons fait nous-mêmes.
  ipcMain.handle("persistent:list", async (event) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    const vues = persistent.list(root)
    const connues = new Set(vues.map((shell) => shell.label))
    for (const label of ws.terminals.attachedLabels(root)) {
      if (connues.has(label)) continue
      connues.add(label)
      vues.push({ name: persistent.nameFor(root, label), label, attached: true })
    }
    vues.sort((a, b) => a.label.localeCompare(b.label))
    return vues
  })

  // Ouvrir : attacher si elle existe, créer sinon. Le rendu envoie l'étiquette
  // tapée par la personne, jamais un nom réel — c'est le principal qui le
  // fabrique, préfixé par ce projet, pour qu'aucune fenêtre ne puisse attacher
  // la session personnelle de quelqu'un en devinant son nom.
  ipcMain.handle("persistent:open", async (event, label: string, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    const name = persistent.nameFor(root, String(label ?? ""))
    const command = persistent.attachCommand(root, name)
    if (!command) throw new Error("No tmux or screen on this machine.")
    const session = ws.terminals.create(
      event.sender,
      root,
      cols || 80,
      rows || 24,
      { daemonOrigin: ws.daemon.current?.origin, daemonToken: ws.daemon.current?.token },
      { command, label: persistent.labelOf(root, name), attached: true }
    )
    return { ...session, name, label: persistent.labelOf(root, name) }
  })

  // Tuer pour de bon, ce que fermer l'onglet ne fait pas. Sans ce geste, une
  // session oubliée tourne des semaines.
  ipcMain.handle("persistent:kill", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    // Le nom vient du rendu : on ne tue que ce qui appartient à ce projet.
    const sien = persistent.list(root).some((shell) => shell.name === name)
    if (!sien) throw new Error("That session does not belong to this project.")
    persistent.kill(name)
    return true
  })

  ipcMain.handle("terminal:running", async (event) => {
    const { ws } = requireWorkspace(event)
    return ws.terminals.running(requireRoot(ws))
  })

  // Ce que les shells de ce projet avaient écrit la dernière fois. Demandé
  // quand il n'en reste aucun de vivant : la fenêtre a été fermée entre-temps,
  // les programmes sont morts avec elle, et il ne reste que ce qu'ils ont dit.
  ipcMain.handle("terminal:saved", async (event) => {
    const { ws } = requireWorkspace(event)
    return ws.terminals.saved(requireRoot(ws))
  })

  // Et leur défilement. En deux temps comme pour les tours d'agent : la page
  // adopte l'identifiant, puis demande ce qui a déjà été écrit.
  ipcMain.handle("terminal:replay", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.terminals.replay(id, event.sender)
    return true
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

  // Les onglets du terminal, composés par le rendu : des identifiants de shell,
  // onglet par onglet. Vérifiés comme tout ce qui vient de la page.
  ipcMain.handle("terminal:layout", async (event, layout: unknown) => {
    const { ws } = requireWorkspace(event)
    if (!Array.isArray(layout) || layout.length > 200) return false
    const propre = layout
      .filter((g): g is unknown[] => Array.isArray(g))
      .map((g) => g.filter((id): id is string => typeof id === "string" && id.length < 200))
      .filter((g) => g.length > 0)
    ws.terminals.setLayout(propre)
    return true
  })

  // La croix d'un onglet de shell : le fermer, et ne plus le rouvrir.
  ipcMain.handle("terminal:close", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.terminals.close(id, ws.project)
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
      const pinned = typeof model === "string" && model.trim() ? model.trim() : null
      // Où ce harnais ira chercher son modèle. Résolu ici parce que c'est ici
      // qu'on peut demander au moteur quels serveurs ce projet a allumés — et
      // null quand il n'y a rien à viser, ce qui laisse le harnais sur son
      // propre compte plutôt que d'échouer.
      const aim = harness(kind).aimable ? await aimFor(pinned, ws.daemon.current) : null

      // codex ne sait poster que sur l'API Responses : il passe par la
      // passerelle de cette fenêtre, qui traduit vers le Chat Completions que
      // nos fournisseurs parlent. Elle s'ouvre ici parce qu'ouvrir une socket
      // est asynchrone et que `send` ne l'est pas — le port doit être connu au
      // moment d'écrire la ligne de commande.
      //
      // La route est le modèle épinglé lui-même, « lmstudio/qwen3-coder-next » :
      // codex le renvoie mot pour mot dans sa requête, et c'est par là que la
      // passerelle sait à quel serveur parler.
      if (aim && pinned) await ws.agent.openGateway(isAgentKind(kind) ? kind : "claude", aim, pinned)

      return ws.agent.send(
        event.sender,
        // Le harnais tel qu'il a été nommé. La forme d'avant — « codex, sinon
        // claude » — était une troisième liste : elle transformait en silence
        // tout nouveau harnais en claude, et le panneau aurait montré « qwen »
        // pendant que claude répondait.
        isAgentKind(kind) ? kind : "claude",
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
        pinned,
        // Only paths this process wrote itself are accepted. The renderer names
        // an attachment by its id; it never hands over a path, so it cannot ask
        // the CLI to read /etc/passwd by calling it an image.
        Array.isArray(images) ? attachments.pathsFor(String(conversationId), images.map(String)) : [],
        aim
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
    for (const conversation of all) {
      // Un fichier écrit avant que les sessions soient séparées n'en porte
      // qu'une : elle appartient au harnais que la conversation portait alors,
      // et c'est la seule lecture honnête qu'on puisse en faire.
      const known = conversation.sessions ?? (conversation.sessionId ? { [conversation.kind]: conversation.sessionId } : {})
      for (const [kind, sessionId] of Object.entries(known)) {
        if (isAgentKind(kind)) ws.agent.resumeAt(kind, conversation.id, sessionId)
      }
    }
    return all
  })

  ipcMain.handle("agent:remember", async (event, conversation: conversations.Conversation) => {
    const { ws } = requireWorkspace(event)
    return conversations.remember(requireRoot(ws), {
      ...conversation,
      // The id the CLI actually reported wins over whatever the renderer last
      // saw: it is learned from the output stream, and the renderer only hears
      // about it through an event that may still be in flight.
      sessionId: ws.agent.sessionFor(conversation.kind, conversation.id) ?? conversation.sessionId ?? null,
      // Et le fil de chaque harnais, pour que basculer et revenir retrouve
      // celui d'avant plutôt que d'en commencer un troisième.
      sessions: { ...conversation.sessions, ...ws.agent.sessionsFor(conversation.id) },
    })
  })

  ipcMain.handle("agent:forget", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.forget(String(id))
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

  // La vignette d'une pièce jointe, par son identifiant. Le chemin ne traverse
  // toujours pas : ce qui revient est une adresse `data:`.
  // Ce que ce harnais sait faire, tel qu'il l'a annoncé la dernière fois qu'il
  // a tourné. Vide tant qu'il n'a jamais tourné ici : c'est lui qui le dit, pas
  // nous, et une liste inventée serait fausse dès le premier greffon installé.
  ipcMain.handle("agent:commands", async (_event, kind: AgentKind) =>
    isAgentKind(kind) ? knownCommands(kind) : []
  )

  ipcMain.handle("agent:thumbnail", async (_event, conversationId: string, id: string) =>
    attachments.thumbnail(String(conversationId), String(id))
  )

  ipcMain.handle("agent:detach", async (_event, conversationId: string, id: string) =>
    attachments.forget(String(conversationId), String(id))
  )

  // The models a CLI offers, read out of its own --help rather than written
  // down here. There is no machine-readable list to ask either of them for, so
  // the choice was between a second list that goes stale and a narrow parse of
  // what the tool states. A parse that finds nothing is not a failure: the
  // picker then offers the default and a box to type a full name in.
  // La ligne qui ouvre le harnais dans le terminal, sur la même conversation.
  ipcMain.handle("agent:interactive-command", async (event, kind: AgentKind, conversationId: string) => {
    const { ws } = requireWorkspace(event)
    if (!isAgentKind(kind)) throw new Error(`Unknown agent: ${String(kind)}`)
    return interactiveCommand(kind, ws.agent.sessionFor(kind, String(conversationId ?? "")))
  })

  // L'auto-synthèse : réécrire une demande avant de l'envoyer (shared/
  // synthesize), en une question au CLI d'agent de la machine — celui du chat
  // s'il sait répondre d'un coup (claude, codex), sinon le premier trouvé.
  // Sans outils ni MCP : il lit un texte et en écrit un autre.
  ipcMain.handle("agent:synthesize", async (event, text: string, mode: string, kind: string) => {
    const { ws } = requireWorkspace(event)
    const demande = String(text ?? "").trim()
    if (!demande) throw new Error("There is nothing to rewrite.")
    if (!isSynthesisMode(mode) || mode === "off") throw new Error(`Unknown rewrite mode: ${String(mode)}`)
    if (demande.length > 40_000) throw new Error("This message is too long to rewrite.")
    const agent = (kind === "claude" || kind === "codex") && installed(kind) ? kind : await commitMessage.availableAgent()
    if (!agent) throw new Error("Rewriting needs the claude or codex CLI on this machine.")
    const cwd = ws.root ?? app.getPath("home")
    return cleanSynthesis(await commitMessage.askOnce(agent, synthesisPrompt(mode, demande), cwd))
  })

  // Ce qui est installé sur cette machine, harnais par harnais, et si npm y est
  // pour installer le reste. Demandé à cli.ts, qui sait que `claude` s'appelle
  // `claude.cmd` sous Windows.
  ipcMain.handle("agent:installed", async () => {
    // Un harnais qui vient de s'installer dans un dossier que le PATH de ce
    // processus ne connaît pas encore — `~/.mimocode/bin` — doit compter.
    adoptHomeBins()
    const harnesses = Object.fromEntries(AGENT_KINDS.map((kind) => [kind, installed(harness(kind).bin)]))
    return { harnesses, npm: installed("npm") }
  })

  /**
   * Installer un harnais absent, dans un onglet du terminal.
   *
   * Un onglet à lui plutôt qu'une ligne tapée dans le shell ouvert : celui-ci
   * peut être un claude en pleine conversation, qui recevrait la commande comme
   * une question. Et un terminal plutôt qu'un processus muet : npm met du temps,
   * peut demander un mot de passe, et échoue parfois — ce qu'il dit doit se lire.
   *
   * Le paquet vient de la table des harnais, jamais de la fenêtre.
   */
  ipcMain.handle("agent:install-shell", async (event, kind: string, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    if (!isAgentKind(kind)) throw new Error(`"${String(kind)}" is not a harness this app knows.`)
    const table = harness(kind)
    let command: { file: string; args: string[]; env?: Record<string, string> }
    if (table.npmPackage) {
      const npm = locate("npm")
      if (!npm) {
        throw new Error("npm was not found on this machine. Install Node.js from https://nodejs.org, then try again.")
      }
      const args = ["install", "-g", table.npmPackage]
      command = npm.needsShell
        ? { file: process.env.COMSPEC || "cmd.exe", args: ["/c", npm.file, ...args] }
        : { file: npm.file, args }
    } else if (table.installer === "mimo") {
      // MiMo Code n'est pas sur npm : l'application le télécharge elle-même
      // (main/mimoinstall.ts), avec son propre exécutable en mode Node — ce qui
      // marche sous Windows, où il n'y a ni bash ni curl à qui le demander.
      const script = path.join(os.tmpdir(), `zyvro-mimo-install-${randomUUID()}.cjs`)
      await fs.writeFile(script, mimoInstall.installerSource(), "utf8")
      command = { file: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } }
    } else {
      throw new Error(`${table.bin} cannot be installed from here. Install it with: ${table.install}`)
    }
    return ws.terminals.create(
      event.sender,
      ws.root ?? app.getPath("home"),
      cols || 80,
      rows || 24,
      null,
      { command, label: `install ${harness(kind).bin}` }
    )
  })

  ipcMain.handle("agent:models", async (event, kind: AgentKind) => {
    // MiMo Code : ses modèles à lui, tels que `mimo models` les liste —
    // « xiaomi/mimo-v2.6-pro — window 1.05M… ». Demandé au binaire plutôt que
    // recopié : ce qui est disponible dépend du compte de la personne.
    if (kind === "mimo") {
      return { models: agentModule.mimoModelsFrom(outputOf("mimo", ["models"])), trouble: [] }
    }
    // Un harnais visable ne choisit pas parmi SES modèles : il choisit parmi
    // ceux des serveurs que ce projet a allumés. C'est la liste que la personne
    // a déjà réglée dans le panneau des fournisseurs, demandée au moteur plutôt
    // que recopiée — « lmstudio/qwen3-coder-next » nomme le serveur et le
    // modèle d'un seul choix.
    if (harness(kind).aimable) {
      const { ws } = requireWorkspace(event)
      const vises = await aimableModels(ws.daemon.current)
      // Les deux listes, et pas seulement celle des serveurs.
      //
      // Tant que claude n'était pas visable, « visable » voulait dire « n'a pas
      // de compte à lui qui vaille un menu ». Ce n'est plus vrai : viser est
      // devenu quelque chose qu'on peut faire avec les trois, et un abonnement
      // reste quelque chose qu'on a. Ne montrer que les serveurs ferait perdre
      // `opus` et `sonnet` à qui ouvre ce menu sur son propre compte — un
      // réglage retiré pour en ajouter un autre.
      //
      // Les siens d'abord : c'est le chemin par défaut. Les visés portent une
      // barre oblique, ce qui les distingue sans qu'on ait à les étiqueter.
      const siens = agentModule.aliasesFrom(helpOf(harness(kind).bin))
      return { models: [...siens, ...vises.models], trouble: vises.trouble }
    }
    // Un CLI n'a pas de serveur à qui la question puisse mal tourner : sa liste
    // vient de son propre --help, et une analyse qui ne trouve rien n'est pas
    // une panne — le sélecteur propose alors le défaut et une case à remplir.
    return { models: agentModule.aliasesFrom(helpOf(harness(kind).bin)), trouble: [] }
  })

  /**
   * Le même harnais, mais dans son interface à lui, dans un shell du panneau.
   *
   * Le panneau lance ces CLI en mode impression et redessine leur flux. C'est
   * ce qu'il faut pour tenir une conversation ici. Mais ces programmes ont leur
   * propre interface, et certaines personnes la préfèrent — ce chemin existe
   * pour elles, sans leur demander de retrouver à la main le dossier, les
   * serveurs MCP du projet et le modèle qu'elles venaient de choisir.
   *
   * Tout ce qu'un tour du panneau aurait eu, ce shell l'a : le même dossier, le
   * même démon, la même visée. Ce qu'il n'a pas, c'est la permission décidée
   * d'avance — dans une interface interactive, c'est la CLI qui demande.
   */
  ipcMain.handle("agent:shell", async (event, kind: string, model: string | null, cols: number, rows: number, conversationId?: string | null) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    // Le harnais vient de la fenêtre : c'est du texte jusqu'à preuve du
    // contraire, et « lance ce harnais » deviendrait sinon « lance ce que je
    // veux ».
    if (!isAgentKind(kind)) throw new Error(`"${String(kind)}" is not a harness this app knows.`)
    const table = harness(kind)

    const found = locate(table.bin)
    if (!found) {
      throw new Error(`"${table.bin}" was not found on this machine. Install it with: ${table.install}`)
    }

    const pinned = typeof model === "string" && model.trim() ? model.trim() : null
    const aim = table.aimable ? await aimFor(pinned, ws.daemon.current) : null
    // La conversation du panneau à reprendre, quand le shell la continue. Son
    // identifiant de session part sur la ligne de commande : lettres, chiffres
    // et tirets, ou rien.
    const session = conversationId ? ws.agent.sessionFor(kind, String(conversationId)) : null
    const resume = session && /^[A-Za-z0-9_-]+$/.test(session) ? session : null
    // La passerelle n'est allumée que si ce harnais en a besoin ET qu'il vise
    // quelque chose — exactement comme pour un tour du panneau, et c'est la
    // même passerelle : elle route sur le nom du modèle, donc deux shells visant
    // deux fournisseurs ne peuvent pas se marcher dessus.
    if (aim && pinned) await ws.agent.openGateway(kind, aim, pinned)
    const passerelle = ws.agent.gatewayAim()

    const env: Record<string, string> = {}
    if (aim && kind === "qwen") Object.assign(env, agentModule.aimEnv(aim))
    // MiMo Code : les serveurs MCP du projet, par son environnement.
    if (kind === "mimo") {
      const config = agentModule.mimoConfig({ daemonOrigin: ws.daemon.current?.origin, daemonToken: ws.daemon.current?.token })
      if (config) env.MIMOCODE_CONFIG_CONTENT = config
    }
    if (aim && passerelle && table.gateway) {
      env[agentModule.GATEWAY_KEY_VAR] = passerelle.token
      if (kind === "claude") Object.assign(env, agentModule.claudeAimEnv(passerelle.origin, passerelle.token))
    }

    // `codexAimArgs` déclare la passerelle comme un fournisseur, et il lui faut
    // le NOM de la variable qui porte la clef, pas la clef : `env_key` dans sa
    // configuration. C'est ce que `GatewayAim` ajoute à la poignée.
    const vise =
      aim && passerelle ? { baseUrl: passerelle.baseUrl, keyVar: agentModule.GATEWAY_KEY_VAR } : null
    const args = agentModule.shellArgsFor(kind, pinned, aim, vise, resume)

    // Sous Windows, `claude` est `claude.cmd` : un script pour l'interpréteur
    // de commandes, que rien ne lance directement. `cli.ts` le signale, et ici
    // la réponse est de lancer l'interpréteur avec lui.
    const command = found.needsShell
      ? { file: process.env.COMSPEC || "cmd.exe", args: ["/c", found.file, ...args], env }
      : { file: found.file, args, env }

    return ws.terminals.create(
      event.sender,
      root,
      cols || 80,
      rows || 24,
      { daemonOrigin: ws.daemon.current?.origin, daemonToken: ws.daemon.current?.token },
      // L'étiquette est ce que l'onglet portera. Le modèle avec, quand il y en
      // a un : deux shells du même harnais sur deux modèles différents sont la
      // raison d'être de ce bouton pour qui compare.
      { command, label: pinned ? `${kind} · ${pinned}` : kind }
    )
  })

  // Arrêter une session qui se réveille toute seule. Le bouton du panneau, et
  // ce que `ScheduleWakeup {stop:true}` demande depuis le flux.
  ipcMain.handle("agent:unschedule", async (event, conversationId: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.unschedule(String(conversationId))
    return true
  })

  ipcMain.handle("agent:cancel", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.cancel(id)
    return true
  })

  // Se rattacher à un tour qui tourne encore.
  //
  // En développement, `electron-vite` recharge le rendu à chaque fichier
  // modifié — c'est ce qui rend l'outil agréable à écrire — mais le processus
  // principal, lui, ne redémarre pas. Un tour en cours continuait donc de
  // tourner et de dépenser pendant que la page neuve n'avait plus aucune idée
  // de son existence.
  ipcMain.handle("agent:running", async (event) => {
    const { ws } = requireWorkspace(event)
    return ws.agent.running()
  })

  // Et rejouer ce qu'il a déjà dit. En deux temps, jamais en un : le rendu doit
  // avoir lié le tour avant que les événements arrivent, sinon il les gare une
  // seconde fois comme orphelins.
  ipcMain.handle("agent:replay", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.replay(id, event.sender)
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
  //
  // « Le projet » veut dire le projet ou l'un de ses sous-dossiers directs qui
  // est un dépôt : `requireGitRoot` rend celui que l'onglet a choisi, et ce
  // choix ne passe que par `git:select-repo`, qui le vérifie.

  ipcMain.handle("git:repositories", async (event) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    // Relu à chaque fois : un agent qui clone ou `git init` un sous-dossier
    // doit le faire apparaître sans qu'on rouvre le projet.
    const repos = await git.repositories(root)
    // Un dossier qui n'est pas un dépôt mais qui en contient : on regarde le
    // premier plutôt que de proposer un `git init` à la racine, qui ferait un
    // dépôt de plus par-dessus ceux qui existent déjà.
    if (repos.length > 0 && !repos.some((repo) => repo.name === ws.gitRepo)) ws.gitRepo = repos[0].name
    const current = await requireGitRoot(ws)
    return { selected: path.relative(root, current), repositories: repos }
  })

  ipcMain.handle("git:select-repo", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    const wanted = String(name ?? "")
    if (wanted && !(git.isRepositoryName(wanted) && (await git.hasOwnRepository(path.join(root, wanted))))) {
      throw new Error(`"${wanted}" is not a Git repository directly inside this project.`)
    }
    ws.gitRepo = wanted
    return wanted
  })

  ipcMain.handle("git:status", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.status(await requireGitRoot(ws))
  })

  ipcMain.handle("git:init", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.init(await requireGitRoot(ws))
  })

  ipcMain.handle("git:stage", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return git.stage(await requireGitRoot(ws), paths.map(String))
  })

  ipcMain.handle("git:unstage", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return git.unstage(await requireGitRoot(ws), paths.map(String))
  })

  ipcMain.handle("git:discard", async (event, paths: string[]) => {
    const { ws } = requireWorkspace(event)
    return git.discard(await requireGitRoot(ws), paths.map(String))
  })

  ipcMain.handle("git:commit", async (event, message: string, options: git.CommitOptions) => {
    const { ws } = requireWorkspace(event)
    return git.commit(await requireGitRoot(ws), String(message), {
      amend: Boolean(options?.amend),
      stageAll: Boolean(options?.stageAll),
    })
  })

  ipcMain.handle("git:diff", async (event, relative: string, staged: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.diff(await requireGitRoot(ws), String(relative), Boolean(staged))
  })

  ipcMain.handle("git:head-text", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    const owner = await gitOwnerOf(ws, String(relative))
    return git.headText(owner.root, owner.relative)
  })

  // `fromProject` : le chemin vient de l'arbre (la Timeline), pas de l'onglet
  // Git, et c'est le dépôt qui tient le fichier qui répond.
  ipcMain.handle("git:file-at", async (event, relative: string, revision: string, fromProject?: boolean) => {
    const { ws } = requireWorkspace(event)
    if (fromProject) {
      const owner = await gitOwnerOf(ws, String(relative))
      return git.fileAt(owner.root, owner.relative, String(revision))
    }
    return git.fileAt(await requireGitRoot(ws), String(relative), String(revision))
  })

  ipcMain.handle("git:file-log", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    const owner = await gitOwnerOf(ws, String(relative))
    return git.fileLog(owner.root, owner.relative)
  })

  ipcMain.handle("git:log", async (event, limit?: number) => {
    const { ws } = requireWorkspace(event)
    return git.log(await requireGitRoot(ws), Number(limit) || 50)
  })

  ipcMain.handle("git:branches", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.branches(await requireGitRoot(ws))
  })

  ipcMain.handle("git:checkout", async (event, branch: string) => {
    const { ws } = requireWorkspace(event)
    return git.checkout(await requireGitRoot(ws), String(branch))
  })

  ipcMain.handle("git:create-branch", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return git.createBranch(await requireGitRoot(ws), String(name))
  })

  ipcMain.handle("git:fetch", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.fetch(await requireGitRoot(ws))
  })

  ipcMain.handle("git:pull", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.pull(await requireGitRoot(ws))
  })

  ipcMain.handle("git:push", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.push(await requireGitRoot(ws))
  })

  ipcMain.handle("git:push-to", async (event, remote: string, setUpstream: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.pushTo(await requireGitRoot(ws), String(remote), Boolean(setUpstream))
  })

  ipcMain.handle("git:push-tags", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.pushTags(await requireGitRoot(ws))
  })

  ipcMain.handle("git:remotes", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.remoteList(await requireGitRoot(ws))
  })

  ipcMain.handle("git:add-remote", async (event, name: string, url: string) => {
    const { ws } = requireWorkspace(event)
    return git.addRemote(await requireGitRoot(ws), String(name), String(url))
  })

  ipcMain.handle("git:remove-remote", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return git.removeRemote(await requireGitRoot(ws), String(name))
  })

  ipcMain.handle("git:stash-list", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.stashList(await requireGitRoot(ws))
  })

  ipcMain.handle("git:stash", async (event, message: string, includeUntracked: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.stash(await requireGitRoot(ws), String(message ?? ""), Boolean(includeUntracked))
  })

  ipcMain.handle("git:stash-pop", async (event, index: number) => {
    const { ws } = requireWorkspace(event)
    return git.stashPop(await requireGitRoot(ws), Number(index))
  })

  ipcMain.handle("git:stash-apply", async (event, index: number) => {
    const { ws } = requireWorkspace(event)
    return git.stashApply(await requireGitRoot(ws), Number(index))
  })

  ipcMain.handle("git:stash-drop", async (event, index: number) => {
    const { ws } = requireWorkspace(event)
    return git.stashDrop(await requireGitRoot(ws), Number(index))
  })

  ipcMain.handle("git:tags", async (event) => {
    const { ws } = requireWorkspace(event)
    return git.tags(await requireGitRoot(ws))
  })

  ipcMain.handle("git:create-tag", async (event, name: string, message: string) => {
    const { ws } = requireWorkspace(event)
    return git.createTag(await requireGitRoot(ws), String(name), String(message ?? ""))
  })

  ipcMain.handle("git:delete-tag", async (event, name: string) => {
    const { ws } = requireWorkspace(event)
    return git.deleteTag(await requireGitRoot(ws), String(name))
  })

  ipcMain.handle("git:rename-branch", async (event, from: string, to: string) => {
    const { ws } = requireWorkspace(event)
    return git.renameBranch(await requireGitRoot(ws), String(from), String(to))
  })

  ipcMain.handle("git:delete-branch", async (event, name: string, force: boolean) => {
    const { ws } = requireWorkspace(event)
    return git.deleteBranch(await requireGitRoot(ws), String(name), Boolean(force))
  })

  ipcMain.handle("git:output", async () => git.output())

  ipcMain.handle("git:agent", async () => commitMessage.availableAgent())

  ipcMain.handle("git:suggest-message", async (event) => {
    const { ws } = requireWorkspace(event)
    return commitMessage.suggest(await requireGitRoot(ws))
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
    const target = accorde(ws, relative) ?? (await files.resolveInside(requireRoot(ws), relative))
    shell.showItemInFolder(target)
    return true
  })

  // Ouvrir avec le programme du système.
  //
  // « Ouvrir avec… » au sens du Finder — un sous-menu qui liste les
  // applications — demande des interfaces macOS qu'Electron n'expose pas. Ce
  // qu'on peut faire honnêtement est ce que fait un double-clic : le programme
  // par défaut pour ce type de fichier. Le menu le dit en ces mots plutôt que
  // de promettre une liste qui n'arrivera pas.
  //
  // Le portail habituel : le chemin vient du rendu, donc il est vérifié contre
  // le dossier ouvert avant d'être passé au système.
  ipcMain.handle("shell:open", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    const target = await files.resolveInside(requireRoot(ws), relative)
    // `openPath` rend une chaîne vide quand il a réussi, et le message du
    // système quand il a échoué — un type de fichier que rien n'ouvre, par
    // exemple. Le rendre plutôt que le jeter : c'est une phrase à afficher.
    const probleme = await shell.openPath(target)
    if (probleme) throw new Error(probleme)
    return true
  })
}

export async function disposeWorkspace(win: BrowserWindow): Promise<void> {
  const ws = workspaces.get(win)
  if (ws) await ws.dispose()
}
