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
import { loginArgs } from "../shared/login"
import { adoptHomeBins, direct, helpOf, installed, locate, outputOf } from "./cli"
import fs from "node:fs/promises"
import * as files from "./files"
import { mediaUrlFor } from "./media"
import { mediaKindOf } from "../shared/media"
import * as textSearch from "./search"
import { createWatcher, type Watcher } from "./watch"
import { forgetRecents, loadRecents, recentFiles, rememberFile, rememberRecent, saveSession } from "./recents"
import { choose as chooseShell, shells as machineShells } from "./shell"
import { authorized, currentAccount, reportBug, signIn, signOut } from "./account"
import { onIncident, recordIncident, sendBugReport, unreportedIncidents } from "./bugreport"
import { captureRegion, saveShot, shareShot, type AskHost, type BrowserHost } from "./shots"
import { answerAsk, askIn } from "./asks"
import type { QuestionAnswers } from "../shared/questions"
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
import * as commitMessage from "./commitmessage"
import * as mimoInstall from "./mimoinstall"
import { readSettingsFile, settingsPath, writeSettingsFile } from "./settingsFile"
import { findMenuItem, flattenMenu } from "./menulist"
import * as updater from "./updater"
import { studioWindows } from "./windows"
import { clearProjectIcon, readProjectIcon, setProjectIcon } from "./projecticon"
import { readTasks, writeTasks } from "./tasks"
import { memoryFileFor, memoryForAgent, readMemory, setMemoryChoicesFile, setMemoryFile, writeMemory } from "./memory"
import { discoverSkills, downloadPack } from "./skills"
import { listAgentPlugins, pluginSkillDirs, removeInstalledPlugin, type PluginRoot } from "./agentPlugins"
import { pluginOn } from "../shared/plugins"
import { sanitizeAgentSettings } from "../shared/settings"
import { skillCatalogPrompt, skillEnabled } from "../shared/skills"
import * as agentShells from "./agentShells"
import { hostedAlive, hostedGateway, hostReady, stopHosted } from "./ptyHostClient"
import { codexMcpArgs, mcpAvailable, mcpServers, mcpTokenEnv, writeMcpConfig } from "./mcp"
import {
  bracketedPaste,
  briefing,
  hasSystemPromptFlag,
  nativePermission,
  parseTranscript,
  supportsEffort,
  EFFORTS,
  nativeArgs,
  promptDelivery,
  recordTitle,
  titleFromTyped,
  sanitizeSpec,
  sessionIdOk,
  taskText,
  toRestore,
  type AgentShellRecord,
} from "../shared/agentShell"
import { speaksCodex } from "../shared/harness"

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
// revient par un canal, avec l'identifiant de la demande (main/asks.ts).
export const askHost: AskHost = async (request) => {
  // Une fenêtre de Studio : une fenêtre de capture n'écoute pas cette question,
  // et l'agent attendrait dix minutes une réponse que personne ne voit.
  const [win] = studioWindows().filter((w) => w.isFocused())
  const target = win ?? studioWindows()[0]
  if (!target) return { allow: false, message: "Zyvro Studio is not open" }
  return await askIn(target.webContents, { tool: request.tool, input: request.input, questions: request.questions })
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

// Où vivent les plugins d'agent (main/agentPlugins). Les livrés sont à côté de
// l'asar, pas dedans (electron-builder.yml, extraResources) : l'agent est un
// autre processus, qui lit leurs SKILL.md par leur chemin, et un chemin dans
// une archive asar n'existe que pour le Node d'Electron.
function installedPluginsDir(): string {
  return path.join(app.getPath("userData"), "agent-plugins")
}

function pluginRoots(root: string | null): PluginRoot[] {
  const roots: PluginRoot[] = [
    { origin: "bundled", dir: app.isPackaged ? path.join(process.resourcesPath, "plugins") : path.join(app.getAppPath(), "resources", "plugins") },
    { origin: "installed", dir: installedPluginsDir() },
  ]
  if (root) roots.push({ origin: "project", dir: path.join(root, ".zyvro", "plugins") })
  return roots
}

// requireRoot rend l'endroit où l'on travaille. Il ne lève plus dès qu'aucun
// projet n'est ouvert : il y a toujours un dossier, celui d'accueil à défaut
// d'un autre. Ce qui lève, c'est un moteur qui n'a pas démarré du tout.
// Combien d'agents on rouvre d'un coup pour un projet : tous ceux qui étaient
// ouverts, dans une limite qui protège d'une liste corrompue.
const MAX_RESTORE = 32

function requireRoot(ws: Workspace): string {
  if (!ws.root) throw new Error("The local engine is not running.")
  return ws.root
}

// harnessLaunch : ce qu'il faut pour lancer un harnais dans son interface à lui,
// et qui ne dépend pas de ce qu'on lui demande — le binaire, la visée du modèle
// (fournisseur local, passerelle) et l'environnement qui l'accompagne.
//
// Partagé par le bouton « terminal » du panneau et par les shells d'agent : deux
// copies de cette logique finiraient par viser deux fournisseurs différents pour
// le même modèle.
async function harnessLaunch(ws: Workspace, kind: AgentKind, pinned: string | null, viaHost = false) {
  const table = harness(kind)
  const found = locate(table.bin)
  if (!found) {
    throw new Error(`"${table.bin}" was not found on this machine. Install it with: ${table.install}`)
  }
  const aim = table.aimable ? await aimFor(pinned, ws.daemon.current) : null
  // La passerelle n'est allumée que si ce harnais en a besoin ET qu'il vise
  // quelque chose — exactement comme pour un tour du panneau, et c'est la
  // même passerelle : elle route sur le nom du modèle, donc deux shells visant
  // deux fournisseurs ne peuvent pas se marcher dessus.
  //
  // Un agent tenu par l'hôte de terminaux passe par la passerelle de l'hôte : elle
  // vit aussi longtemps que lui, à la même adresse, même quand Zyvro redémarre.
  let passerelle: { baseUrl: string; origin: string; token: string } | null = null
  if (aim && pinned && viaHost && table.gateway) {
    passerelle = await hostedGateway(pinned, aim)
  } else {
    if (aim && pinned) await ws.agent.openGateway(kind, aim, pinned)
    passerelle = ws.agent.gatewayAim()
  }

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
  return { table, found, aim, vise, env }
}

// requireGitRoot rend le dossier du dépôt choisi dans l'onglet Git. Le nom
// vient de la fenêtre mais il a été vérifié à la sélection (`git:select-repo`) :
// un seul segment, sous la racine, avec un `.git`. Il est revérifié ici parce
// que le dossier a pu disparaître depuis, et qu'on retombe alors sur le projet
// plutôt que de lancer git dans le vide.
// noteSession : les projets de cette fenêtre, à rouvrir au prochain lancement.
function noteSession(ws: Workspace): void {
  saveSession({ projects: ws.list().map((p) => p.project), active: ws.current()?.project ?? null })
}

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

  // Le bouton bug rougit quand une erreur entre au journal.
  onIncident((count) => {
    for (const win of studioWindows()) if (!win.isDestroyed()) win.webContents.send("bug:incidents", count)
  })

  // ---------- l'icône d'un projet ----------
  //
  // Un chemin venu du rendu n'est accepté que s'il est l'un des projets
  // ouverts dans CETTE fenêtre : sans ça, n'importe quelle page chargée dans
  // le rendu pourrait écrire `.zyvro/icon.png` n'importe où sur le disque.
  const openProjectFor = (event: Electron.IpcMainInvokeEvent, project: unknown): string => {
    const { ws } = requireWorkspace(event)
    const wanted = typeof project === "string" ? project : ""
    const found = ws.list().find((p) => p.project === wanted)
    if (!found) throw new Error("That project is not open in this window.")
    return found.project
  }
  const iconChanged = (project: string, icon: string | null) => {
    for (const win of studioWindows()) if (!win.isDestroyed()) win.webContents.send("project:icon-changed", { project, icon })
  }
  ipcMain.handle("project:icon", async (event, project: unknown) => readProjectIcon(openProjectFor(event, project)))
  ipcMain.handle("project:choose-icon", async (event, project: unknown) => {
    const root = openProjectFor(event, project)
    const { win } = requireWorkspace(event)
    const result = await dialog.showOpenDialog(win, {
      title: `Choose an icon for ${path.basename(root)}`,
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      buttonLabel: "Use as icon",
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const icon = await setProjectIcon(root, result.filePaths[0])
      iconChanged(root, icon)
      return icon
    } catch (err) {
      // Dit là où l'on vient de choisir le fichier, par le même système.
      await dialog.showMessageBox(win, { type: "warning", message: "That image cannot be used as an icon.", detail: (err as Error).message })
      return null
    }
  })
  ipcMain.handle("project:clear-icon", async (event, project: unknown) => {
    const root = openProjectFor(event, project)
    await clearProjectIcon(root)
    iconChanged(root, null)
    return true
  })

  // ---------- la file de tâches et la mémoire d'un projet ----------
  //
  // Même garde que l'icône : seulement un projet ouvert dans cette fenêtre.
  // Une file changée ici est rediffusée à toutes les fenêtres, pour qu'une
  // seconde fenêtre sur le même projet ne relance pas une tâche déjà partie.
  ipcMain.handle("tasks:read", async (event, project: unknown) => readTasks(openProjectFor(event, project)))
  ipcMain.handle("tasks:write", async (event, project: unknown, file: unknown) => {
    const root = openProjectFor(event, project)
    const written = await writeTasks(root, file)
    for (const win of studioWindows()) {
      if (!win.isDestroyed() && win.webContents !== event.sender) win.webContents.send("tasks:changed", { project: root, file: written })
    }
    return written
  })
  setMemoryChoicesFile(path.join(app.getPath("userData"), "memory-files.json"))
  ipcMain.handle("memory:read", async (event, project: unknown) => readMemory(openProjectFor(event, project)))
  // Le fichier de mémoire de ce projet : un nom proposé, ou null pour ZYVRO.md.
  ipcMain.handle("memory:set-file", async (event, project: unknown, relative: unknown) =>
    setMemoryFile(openProjectFor(event, project), typeof relative === "string" ? relative : null)
  )
  // …ou n'importe quel fichier du projet, choisi dans le Finder. Hors du
  // projet : refusé, rien n'est changé.
  ipcMain.handle("memory:pick-file", async (event, project: unknown) => {
    const { win } = requireWorkspace(event)
    const root = openProjectFor(event, project)
    const result = await dialog.showOpenDialog(win, {
      title: "Choose the project memory file",
      defaultPath: root,
      properties: ["openFile"],
      filters: [
        { name: "Markdown and text", extensions: ["md", "mdx", "markdown", "txt", "rst"] },
        { name: "All files", extensions: ["*"] },
      ],
    })
    const chosen = result.canceled ? undefined : result.filePaths[0]
    if (!chosen) return null
    const rel = path.relative(await fs.realpath(root), await fs.realpath(chosen).catch(() => chosen))
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Choose a file inside the project.")
    return setMemoryFile(root, rel.split(path.sep).join("/"))
  })
  ipcMain.handle("memory:write", async (event, project: unknown, text: unknown) =>
    writeMemory(openProjectFor(event, project), typeof text === "string" ? text : "")
  )

  ipcMain.handle("window:is-fullscreen", async (event) => requireWorkspace(event).win.isFullScreen())

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
      // Only a folder that opened successfully is worth offering again.
      rememberRecent(dir)
      onRecentsChanged?.()
      slot.startupPending = false
      noteSession(ws)
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
    noteSession(ws)
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
    noteSession(ws)
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

  // Une vidéo ou un son du projet (ou accordé) : une adresse que le lecteur
  // interroge par morceaux, jamais le chemin (main/media.ts).
  ipcMain.handle("files:media-url", async (event, relative: string) => {
    const { ws } = requireWorkspace(event)
    const p = String(relative ?? "")
    if (!mediaKindOf(p)) throw new Error(`"${p}" is not a video or audio file.`)
    const file = accorde(ws, p) ?? (await files.resolveInside(requireRoot(ws), p))
    return mediaUrlFor(file)
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
  // `answers` : les réponses d'un formulaire de questions, par identifiant de
  // question. Venues du rendu, donc relues : des chaînes, rien d'autre.
  ipcMain.handle("agent:permission-answer", async (event, id: string, allow: boolean, answers?: unknown) => {
    requireWorkspace(event)
    return answerAsk(String(id), {
      allow: allow === true,
      message: allow === true ? undefined : "you said no",
      answers: allow === true ? cleanAnswers(answers) : undefined,
    })
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
  let telecharge: { file: string; info: updater.UpdateInfo } | null = null
  ipcMain.handle("update:check", async () => {
    proposee = await updater.checkForUpdate()
    return proposee
  })
  ipcMain.handle("update:download", async (event) => {
    if (!proposee) throw new Error("There is no update to download.")
    const info = proposee
    telecharge = null
    const r = await updater.downloadUpdate(info, event.sender)
    telecharge = { file: r.file, info }
    return r
  })
  ipcMain.handle("update:install", async () => {
    if (!telecharge) throw new Error("Download the update first.")
    // Another window may have checked for a newer release meanwhile. Install
    // the version that belongs to these verified bytes, not the latest check.
    return updater.installUpdate(telecharge.file, telecharge.info)
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

  ipcMain.handle("terminal:create", async (event, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)

    // Le démon du projet part avec le shell : un agent lancé à la main dedans
    // doit pouvoir joindre les mêmes serveurs MCP que celui du panneau.
    return ws.terminals.create(
      event.sender,
      root,
      cols || 80,
      rows || 24,
      {
        daemonOrigin: ws.daemon.current?.origin,
        daemonToken: ws.daemon.current?.token,
      },
      {}
    )
  })

  // Reprendre les shells d'un projet après un rechargement du rendu.
  //
  // Les ptys sont des enfants du processus principal : une page qui recharge ne
  // les tue pas, elle les oublie. Ils continuaient donc d'écrire dans le vide,
  // injoignables jusqu'à la fermeture de la fenêtre, pendant que la page neuve
  // en ouvrait un de plus à côté.
  ipcMain.handle("terminal:running", async (event) => {
    const { ws } = requireWorkspace(event)
    return ws.terminals.running(requireRoot(ws))
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

  ipcMain.handle("agent:skills", async (event, kind: AgentKind) => {
    const { ws } = requireWorkspace(event)
    if (!isAgentKind(kind)) throw new Error("Unknown agent")
    const root = requireRoot(ws)
    // Tous les plugins chargés, allumés ou non : c'est la page qui les liste,
    // et le tour, lui, retire ceux qu'on a éteints (agent:send).
    const plugins = pluginSkillDirs(await listAgentPlugins(pluginRoots(root)), [])
    return discoverSkills(kind, root, path.join(app.getPath("userData"), "skill-packs"), os.homedir(), process.env, plugins)
  })

  // Les plugins d'agent en paquets (main/agentPlugins) : livrés, installés
  // depuis la boutique, et ceux que le projet est en train d'écrire.
  ipcMain.handle("plugins:list", async (event) => {
    const { ws } = requireWorkspace(event)
    return listAgentPlugins(pluginRoots(ws.root))
  })

  // Désinstaller ne touche qu'aux plugins venus de la boutique : un plugin du
  // projet est un fichier du projet, et l'app livre les siens.
  ipcMain.handle("plugins:uninstall", async (event, name: string) => {
    requireWorkspace(event)
    await removeInstalledPlugin(installedPluginsDir(), String(name))
    return true
  })

  ipcMain.handle("agent:download-pack", async (event, repository: string) => {
    requireWorkspace(event)
    const git = locate("git")
    if (!git || git.needsShell) throw new Error("Install Git before downloading a skill pack.")
    return downloadPack(String(repository), path.join(app.getPath("userData"), "skill-packs"), git.file)
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
      const agentSettings = sanitizeAgentSettings(ctx?.agentSettings)
      // Les deux fonctions de l'agent qui se décident ici, au lancement du
      // tour (shared/plugins) : un plugin éteint n'envoie rien à l'agent.
      const advancedSkills = ctx?.advancedSkills === true && pluginOn(agentSettings, "skills")
      const catalog = advancedSkills
        ? await discoverSkills(
            isAgentKind(kind) ? kind : "claude", root, path.join(app.getPath("userData"), "skill-packs"), os.homedir(), process.env,
            // Les skills des plugins allumés rejoignent le catalogue.
            pluginSkillDirs(await listAgentPlugins(pluginRoots(root)), agentSettings.disabledPlugins)
          )
        : null
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
      // La mémoire du projet, relue à chaque tour : corrigée entre deux tours,
      // c'est la nouvelle que reçoit le suivant.
      const memory = pluginOn(agentSettings, "memory") ? await memoryForAgent(root) : null
      const memoryFile = memoryFileFor(root)

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
          advancedSkills,
          skills: catalog?.skills.filter((skill) => skillEnabled(skill, agentSettings)) ?? [],
          workflows: Array.isArray(ctx?.workflows) ? ctx.workflows : [],
          daemonOrigin: ws.daemon.current?.origin,
          daemonToken: ws.daemon.current?.token,
          memory,
          memoryFile,
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

  // ---- les réglages, dans un fichier qu'on retrouve ----
  //
  // `<dossier de l'app>/settings.json`. Le rendu y écrit à chaque changement et
  // le relit au démarrage ; Export et Import passent par de vraies boîtes de
  // dialogue, rien n'est écrit ni lu ailleurs que là où la personne a choisi.
  ipcMain.handle("settings:file-read", async () => ({ path: settingsPath(), settings: await readSettingsFile() }))
  ipcMain.handle("settings:file-write", async (_event, settings: unknown) => {
    await writeSettingsFile(settings)
    return settingsPath()
  })
  ipcMain.handle("settings:reveal", async () => {
    // Le fichier n'existe qu'après le premier changement : on montre le dossier
    // sinon, plutôt que de ne rien faire.
    const file = settingsPath()
    const there = await fs.stat(file).catch(() => null)
    if (there) shell.showItemInFolder(file)
    else await shell.openPath(path.dirname(file))
    return file
  })
  ipcMain.handle("settings:export", async (event, settings: unknown) => {
    const { win } = requireWorkspace(event)
    const chosen = await dialog.showSaveDialog(win, {
      title: "Export settings",
      defaultPath: path.join(app.getPath("downloads"), "zyvro-settings.json"),
      buttonLabel: "Export",
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (chosen.canceled || !chosen.filePath) return null
    await writeSettingsFile(settings, chosen.filePath)
    return chosen.filePath
  })
  ipcMain.handle("settings:import", async (event) => {
    const { win } = requireWorkspace(event)
    const chosen = await dialog.showOpenDialog(win, {
      title: "Import settings",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (chosen.canceled || chosen.filePaths.length === 0) return null
    const settings = await readSettingsFile(chosen.filePaths[0])
    if (settings === null || typeof settings !== "object") {
      throw new Error("That file is not a settings file Zyvro can read.")
    }
    return { path: chosen.filePaths[0], settings }
  })

  // ---- une image du chat, en grand : où elle est, l'ouvrir, la garder ----
  //
  // Demandé par Jeremy : cliquer une image qu'un outil a lue pour la voir en
  // grand, ouvrir le dossier où elle est, la télécharger. Le rendu ne connaît
  // que l'identifiant d'une image, jamais son chemin ; c'est ici qu'on le
  // retrouve.
  //
  // `source` est le fichier qu'un outil Read a lu, tel que la ligne de l'outil
  // le nomme : « montrer dans le dossier » montre alors l'original, dans le
  // projet, plutôt que la copie que l'application a rangée. Il vient de la
  // fenêtre, donc il n'est suivi que s'il désigne un fichier image qui existe.
  const imageFile = async (event: Electron.IpcMainInvokeEvent, conversationId: string, id: string, source?: string | null) => {
    if (typeof source === "string" && source.trim()) {
      const { ws } = requireWorkspace(event)
      const raw = source.trim()
      const candidate = path.isAbsolute(raw) ? raw : ws.root ? path.resolve(ws.root, raw) : ""
      const stat = candidate ? await fs.stat(candidate).catch(() => null) : null
      if (stat?.isFile() && /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif|heic)$/i.test(candidate)) {
        return { file: candidate, original: true }
      }
    }
    const [stored] = attachments.pathsFor(String(conversationId), [String(id)])
    return stored ? { file: stored, original: false } : null
  }

  ipcMain.handle("agent:image-reveal", async (event, conversationId: string, id: string, source?: string | null) => {
    const found = await imageFile(event, conversationId, id, source)
    if (!found) throw new Error("This image is no longer on disk.")
    shell.showItemInFolder(found.file)
    return found.original ? "original" : "copy"
  })

  ipcMain.handle("agent:image-open", async (event, conversationId: string, id: string, source?: string | null) => {
    const found = await imageFile(event, conversationId, id, source)
    if (!found) throw new Error("This image is no longer on disk.")
    // L'application par défaut de la machine : Aperçu sur un Mac.
    const failed = await shell.openPath(found.file)
    if (failed) throw new Error(failed)
    return true
  })

  // Enregistrer sous : une vraie boîte de dialogue, proposée dans les
  // téléchargements sous le nom de l'image. Rien n'est écrit ailleurs que là
  // où la personne a choisi.
  ipcMain.handle("agent:image-save", async (event, conversationId: string, id: string, name: string, source?: string | null) => {
    const { win } = requireWorkspace(event)
    const found = await imageFile(event, conversationId, id, source)
    if (!found) throw new Error("This image is no longer on disk.")
    const ext = path.extname(found.file)
    const base = (typeof name === "string" && name.trim() ? path.basename(name.trim()) : path.basename(found.file)).replace(/[\\/:*?"<>|]/g, "_")
    const suggested = path.extname(base) ? base : `${base}${ext}`
    const chosen = await dialog.showSaveDialog(win, {
      title: "Save image",
      defaultPath: path.join(app.getPath("downloads"), suggested),
      buttonLabel: "Save",
    })
    if (chosen.canceled || !chosen.filePath) return null
    await fs.copyFile(found.file, chosen.filePath)
    return chosen.filePath
  })

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
  ipcMain.handle("agent:login-shell", async (event, kind: string, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    if (!isAgentKind(kind)) throw new Error(`"${String(kind)}" is not a harness this app knows.`)
    const table = harness(kind)
    const found = locate(table.bin)
    if (!found) throw new Error(`"${table.bin}" was not found on this machine. Install it with: ${table.install}`)
    const how = direct(found)
    const args = [...how.prefix, ...loginArgs(kind)]
    const command = how.shell
      ? { file: process.env.COMSPEC || "cmd.exe", args: ["/c", how.file, ...args] }
      : { file: how.file, args }
    // No gateway, model, MCP or permission overrides during authentication.
    // Inherit the same HOME/config environment as the panel's agent process.
    const session = ws.terminals.create(event.sender, requireRoot(ws), cols || 80, rows || 24, null, { command, label: `login ${kind}` })
    return { ...session, banner: `Sign in with ${table.bin} below. Once the CLI confirms sign-in, return to the agent panel and send your message.\r\n` }
  })

  ipcMain.handle("agent:shell", async (event, kind: string, model: string | null, cols: number, rows: number, conversationId?: string | null) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    // Le harnais vient de la fenêtre : c'est du texte jusqu'à preuve du
    // contraire, et « lance ce harnais » deviendrait sinon « lance ce que je
    // veux ».
    if (!isAgentKind(kind)) throw new Error(`"${String(kind)}" is not a harness this app knows.`)
    const pinned = typeof model === "string" && model.trim() ? model.trim() : null
    // La conversation du panneau à reprendre, quand le shell la continue. Son
    // identifiant de session part sur la ligne de commande : lettres, chiffres
    // et tirets, ou rien.
    const session = conversationId ? ws.agent.sessionFor(kind, String(conversationId)) : null
    const resume = session && /^[A-Za-z0-9_-]+$/.test(session) ? session : null
    const { found, aim, vise, env } = await harnessLaunch(ws, kind, pinned)

    const args = agentModule.shellArgsFor(kind, pinned, aim, vise, resume)

    // Sous Windows, `claude` est `claude.cmd` : un script pour l'interpréteur
    // de commandes, que rien ne lance directement. `cli.ts` le signale, et ici
    // la réponse est de lancer l'interpréteur avec lui.
    const how = direct(found)
    const nativeArgs = [...how.prefix, ...args]
    const command = how.shell
      ? { file: process.env.COMSPEC || "cmd.exe", args: ["/c", how.file, ...nativeArgs], env }
      : { file: how.file, args: nativeArgs, env }

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

  // ---------- Shell + Agents ----------
  //
  // Un agent est un shell dont le programme est un harnais. La fenêtre envoie
  // une configuration (shared/agentShell) et une tâche ; ce côté la traduit en
  // drapeaux natifs, branche les serveurs MCP du projet, garde la session sur le
  // disque et rend un shell ordinaire du panneau.
  const agentShellsDir = (): string => path.join(app.getPath("userData"), "agent-shells")
  // Les sondages qui attendent que codex dise quelle est sa session.
  const sessionWatchers = new Map<string, () => void>()

  // Les identifiants que d'autres onglets ont déjà revendiqués : deux codex lancés
  // dans le même dossier ne doivent pas se voler leur session.
  const takenSessions = (records: AgentShellRecord[], except: string): Set<string> =>
    new Set(records.flatMap((item) => (item.id !== except && item.sessionId ? [item.sessionId] : [])))

  const liveAgentShells = (ws: Workspace, root: string): Set<string> =>
    new Set(ws.terminals.running(root).flatMap((shell) => (shell.agentShell ? [shell.agentShell] : [])))

  // Les workflows viennent de la fenêtre (elle les a déjà demandés au démon) :
  // des chaînes, en nombre borné, jamais autre chose sur une ligne de commande.
  const cleanWorkflows = (raw: unknown): AgentContext["workflows"] =>
    Array.isArray(raw)
      ? raw.slice(0, 200).flatMap((item) => {
          const w = item as { id?: unknown; name?: unknown; description?: unknown }
          return typeof w?.id === "string" && typeof w?.name === "string"
            ? [{ id: w.id.slice(0, 200), name: w.name.slice(0, 200), description: typeof w.description === "string" ? w.description.slice(0, 400) : undefined }]
            : []
        })
      : []

  // Les skills qu'un agent natif reçoit : ceux du harnais, des packs et des
  // plugins allumés, moins ceux qu'on a éteints.
  const shellSkills = async (kind: AgentKind, root: string, agentSettings: ReturnType<typeof sanitizeAgentSettings>) =>
    (
      await discoverSkills(
        kind, root, path.join(app.getPath("userData"), "skill-packs"), os.homedir(), process.env,
        pluginSkillDirs(await listAgentPlugins(pluginRoots(root)), agentSettings.disabledPlugins)
      )
    ).skills.filter((skill) => skillEnabled(skill, agentSettings))

  // Activer les skills avancés pendant qu'un agent tourne : il ne peut plus
  // recevoir de prompt système, alors le catalogue part comme un message, dans
  // son interface. Vide quand le plugin est éteint ou qu'il n'y a rien à offrir.
  ipcMain.handle("agentshell:skills-brief", async (event, rawKind: unknown, rawSettings: unknown) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    if (!isAgentKind(rawKind)) throw new Error("Unknown agent")
    const agentSettings = sanitizeAgentSettings(rawSettings)
    if (!pluginOn(agentSettings, "skills")) return ""
    const catalog = await shellSkills(rawKind, root, agentSettings)
    return catalog.length > 0 ? skillCatalogPrompt(catalog, true) : ""
  })

  ipcMain.handle("agentshell:open", async (event, rawSpec: unknown, rawContext: unknown, cols: number, rows: number) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    const asked = sanitizeSpec(rawSpec)
    if (!asked) throw new Error("That is not an agent this app knows how to start.")
    const context = (rawContext && typeof rawContext === "object" ? rawContext : {}) as { workflows?: unknown; agentSettings?: unknown }
    const dir = agentShellsDir()
    const notify = (): void => {
      if (!event.sender.isDestroyed()) event.sender.send("agentshell:changed")
    }

    // Reprendre : la configuration et la session viennent de l'enregistrement,
    // pas de la fenêtre. Une session rouverte demain garde sa permission.
    const known = await agentShells.load(dir, root)
    const previous = asked.resume ? known.find((item) => item.id === asked.resume) : undefined
    if (asked.resume && !previous) throw new Error("That agent session is no longer in the list.")
    if (previous) {
      const live = ws.terminals.byAgentShell(previous.id)
      // Déjà ouverte : on la montre au lieu d'en lancer une seconde sur la même
      // conversation, deux processus qui écrivent le même journal.
      if (live) return { id: live, pty: true, existing: true, record: previous }
    }

    // Tenu par l'hôte de terminaux : l'agent survit à la fermeture de Zyvro. S'il
    // tourne encore, on s'y rattache — rien à reprendre, il n'a jamais arrêté.
    //
    // Pas sous Windows pour l'instant : ConPTY, lancé depuis l'hôte détaché, rendait
    // un agent qui se terminait aussitôt (vu sur la machine de build Windows), et
    // rien ici ne permet encore de le vérifier. Là-bas les agents restent dans
    // l'application, comme avant — mieux qu'un agent qui meurt au démarrage.
    const detach = process.platform !== "win32" && sanitizeAgentSettings(context.agentSettings).detachAgents
    const dimLine = (line: string): string => `\x1b[2m${line}\x1b[0m\r\n`
    // Qu'il soit tenu par l'hôte se vérifie même réglage coupé : lancé détaché
    // avant qu'on le coupe, il tourne toujours, et le relancer ici mettrait un
    // second processus sur la même conversation.
    if (previous && (await hostedAlive()).has(previous.id)) {
      const session = ws.terminals.create(event.sender, root, cols || 80, rows || 24, null, {
        agentShell: previous.id,
        hosted: { key: previous.id, spawn: false },
        cleanup: () => {
          sessionWatchers.get(previous.id)?.()
          sessionWatchers.delete(previous.id)
        },
        onEnd: () => {
          void agentShells.patch(dir, root, previous.id, { state: "closed" }).then(notify, notify)
        },
      })
      const reopened = await agentShells.patch(dir, root, previous.id, { state: "open" })
      if (speaksCodex(previous.kind) && !previous.sessionId) {
        const stop = agentShells.watchCodexSession(
          root,
          Date.parse(previous.createdAt) - 5000,
          () => takenSessions(known, previous.id),
          (id) => {
            sessionWatchers.delete(previous.id)
            void agentShells.patch(dir, root, previous.id, { sessionId: id }).then(notify, notify)
          }
        )
        sessionWatchers.set(previous.id, stop)
      }
      notify()
      const banner = dimLine(
        `Zyvro · ${previous.kind}${previous.model ? ` · ${previous.model}` : ""} · reattached: it kept running while Zyvro was closed`
      )
      return { ...session, banner, record: reopened.find((item) => item.id === previous.id) ?? previous }
    }
    // L'hôte doit répondre AVANT qu'on lance : s'il ne peut pas démarrer, l'agent
    // tourne dans l'application comme avant, et on le dit.
    let viaHost = false
    let hostNotice = ""
    if (detach) {
      try {
        await hostReady()
        viaHost = true
      } catch (err) {
        hostNotice = `Background host unavailable (${(err as Error).message}): this agent stops when Zyvro quits.`
      }
    }
    const spec = previous
      ? { ...asked, kind: previous.kind, model: previous.model, permission: previous.permission, effort: previous.effort,
          instructions: previous.instructions, mcp: previous.mcp, skills: previous.skills, name: previous.name,
          profileId: previous.profileId, prompt: "" }
      : asked
    const kind = spec.kind
    const { found, aim, vise, env } = await harnessLaunch(ws, kind, spec.model, viaHost)

    // Changer de harnais : une session n'a de sens que pour le sien, alors le nouvel
    // agent reçoit en premier message un briefing tiré du transcript de l'ancienne.
    let prompt = spec.prompt
    if (!previous && spec.handoff) {
      const source = known.find((item) => item.id === spec.handoff)
      if (!source) throw new Error("The session to take over is no longer in the list.")
      const raw = source.sessionId ? agentShells.readTranscript(source.kind, source.sessionId) : null
      const text = briefing({
        turns: raw ? parseTranscript(source.kind, raw) : [],
        from: { kind: source.kind, model: source.model },
        to: { kind, model: spec.model },
      })
      prompt = spec.prompt ? `${text}\n\n${spec.prompt}` : text
    }

    // ---- la session
    const fromChat = !previous && spec.conversation ? ws.agent.sessionFor(kind, spec.conversation) : null
    let sessionId = previous?.sessionId ?? (sessionIdOk(fromChat) ? fromChat : null)
    let assign = false
    let notice = ""
    if (kind === "claude") {
      if (!(sessionId && agentShells.claudeSessionExists(sessionId))) {
        // Pas de journal : rien à reprendre. Neuve, avec cet identifiant — on le
        // connaît donc dès le départ, sans attendre que la CLI le dise.
        if (previous?.sessionId) notice = "Nothing was said in the previous session yet: starting it again under the same id."
        sessionId = sessionId ?? randomUUID()
        assign = true
      }
    } else if (speaksCodex(kind)) {
      // Un identifiant jamais appris (le journal n'était pas encore là quand on
      // surveillait, ou l'agent a été arrêté entre-temps) : on le retrouve par le
      // journal que codex a écrit depuis la création de l'onglet.
      if (previous && !sessionId) {
        sessionId = agentShells.findCodexSession(root, Date.parse(previous.createdAt) - 5000, takenSessions(known, previous.id))
        if (sessionId) await agentShells.patch(dir, root, previous.id, { sessionId })
      }
      // Un identifiant connu sans journal sous les yeux : on tente quand même la
      // reprise. Codex retrouve ses sessions par son propre index, et repartir de
      // zéro en silence est la pire réponse — la session semble perdue alors qu'elle
      // ne l'est peut-être pas. S'il ne la connaît pas, il le dit à l'écran.
      if (sessionId && !agentShells.codexSessionExists(sessionId)) {
        notice = "No log of this codex session was found here; trying to resume it anyway."
      }
    } else if (previous && !sessionId) {
      notice = `${kind} does not tell us its session id: this opens a new conversation. Use its own /resume to go back.`
    }

    // ---- ce que l'agent sait de ce projet
    const agentSettings = sanitizeAgentSettings(context.agentSettings)
    const skillsOn = spec.skills && pluginOn(agentSettings, "skills")
    const catalog = skillsOn ? await shellSkills(kind, root, agentSettings) : []
    const memory = pluginOn(agentSettings, "memory") ? await memoryForAgent(root) : null
    const memoryFile = memoryFileFor(root)
    const target = { daemonOrigin: ws.daemon.current?.origin, daemonToken: ws.daemon.current?.token }
    const sections = [
      agentModule.preamble({
        projectDir: root, workflows: cleanWorkflows(context.workflows), memory, memoryFile, ...target,
      }),
    ]
    if (spec.instructions.trim()) sections.push(`Additional instructions for this session:\n${spec.instructions.trim()}`)
    if (skillsOn) sections.push(skillCatalogPrompt(catalog, true))
    const systemPrompt = sections.join("\n\n")

    // ---- les serveurs MCP du projet
    let mcpArgs: string[] = []
    let disposeMcp = (): void => undefined
    const useMcp = spec.mcp && mcpAvailable(target)
    if (!useMcp) delete env.MIMOCODE_CONFIG_CONTENT
    if (useMcp) {
      const servers = Object.keys(mcpServers(target))
      if (kind === "claude") {
        const config = writeMcpConfig(target)
        disposeMcp = config.dispose
        // Seuls les outils de Zyvro sont pré-accordés ; le reste suit la
        // permission choisie.
        mcpArgs = ["--mcp-config", config.path, "--allowedTools", servers.map((name) => `mcp__${name}`).join(",")]
      } else if (kind === "qwen") {
        const config = writeMcpConfig(target, "qwen")
        disposeMcp = config.dispose
        mcpArgs = ["--mcp-config", config.path, "--allowed-mcp-server-names", ...servers, "--allowed-tools", ...servers.map((name) => `mcp__${name}`)]
      } else if (speaksCodex(kind)) {
        Object.assign(env, mcpTokenEnv(target))
        mcpArgs = codexMcpArgs(target)
      }
    }

    // ---- la tâche : en argument si le harnais la prend et que la ligne le
    // supporte, collée dans son invite sinon.
    const how = direct(found)
    // Sous Windows un harnais qui n'est qu'un script `.cmd` passe par cmd.exe, qui
    // interprète ce qu'on lui donne (`&`, `|`, `%`, les retours à la ligne). Rien
    // de libre ne part alors sur la ligne : ni prompt système, ni nom, et un
    // modèle qui n'a que des caractères de nom de modèle. Le préambule suit la
    // tâche, collée dans l'invite.
    const viaCmd = how.shell
    if (viaCmd && spec.model && !/^[\w.:/@+-]+$/.test(spec.model)) {
      throw new Error(`"${spec.model}" cannot be passed to ${kind} through cmd.exe: use a plain model name.`)
    }
    // Le prompt système en argument, quand le harnais en a un et qu'il tient :
    // un seul argument au-delà de 128 Kio fait échouer le lancement sous Linux
    // (E2BIG), et toute la ligne est bornée à 32 767 caractères sous Windows.
    // Une mémoire de projet et un gros catalogue de skills y arrivent. Trop long :
    // il précède la tâche, comme pour un harnais qui n'a pas ce drapeau.
    const systemFits = Buffer.byteLength(systemPrompt) <= (process.platform === "win32" ? 16_000 : 60_000)
    const systemAsArg = hasSystemPromptFlag(kind) && !viaCmd && systemFits
    const task =
      !systemAsArg && prompt && systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : taskText(kind, systemPrompt, prompt)
    // cmd.exe ne sait pas porter un retour à la ligne ni ses propres signes dans
    // un argument ; une très longue tâche n'a rien à faire dans argv non plus.
    const argvOk =
      promptDelivery(kind) === "argv" && task.length <= 20_000 && (!how.shell || /^[\w .,:;'()\/@#$*+=~\[\]{}-]*$/.test(task))
    const args = nativeArgs({
      kind,
      model: spec.model,
      permission: spec.permission,
      effort: spec.effort,
      name: viaCmd ? "" : spec.name || recordTitle({ name: "", prompt: spec.prompt, kind, model: spec.model }),
      sessionId,
      assign,
      systemPrompt: systemAsArg ? systemPrompt : "",
      mcpArgs,
      aimArgs: kind === "qwen" ? (aim ? agentModule.aimArgs(aim) : []) : speaksCodex(kind) && aim && vise ? agentModule.codexAimArgs(vise) : [],
      prompt: argvOk ? task : "",
    })
    const nativeArgv = [...how.prefix, ...args]
    const command = how.shell
      ? { file: process.env.COMSPEC || "cmd.exe", args: ["/c", how.file, ...nativeArgv], env }
      : { file: how.file, args: nativeArgv, env }

    // ---- l'enregistrement
    const now = new Date().toISOString()
    const record: AgentShellRecord = {
      id: previous?.id ?? randomUUID(),
      kind,
      model: spec.model,
      permission: spec.permission,
      effort: spec.effort,
      instructions: spec.instructions,
      mcp: spec.mcp,
      skills: spec.skills,
      name: spec.name,
      profileId: spec.profileId,
      sessionId,
      prompt: previous?.prompt || spec.prompt,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      state: "open",
    }
    const started = Date.now()
    const session = ws.terminals.create(
      event.sender,
      root,
      cols || 80,
      rows || 24,
      target,
      {
        command,
        agentShell: record.id,
        ...(viaHost ? { hosted: { key: record.id, spawn: true } } : {}),
        cleanup: () => {
          disposeMcp()
          sessionWatchers.get(record.id)?.()
          sessionWatchers.delete(record.id)
        },
        // Terminé ou fermé à la main : la session reste dans la liste, et ne
        // se rouvrira plus toute seule.
        onEnd: () => {
          void agentShells.patch(dir, root, record.id, { state: "closed" }).then(notify, notify)
        },
      }
    )
    await agentShells.upsert(dir, root, record)

    // codex choisit lui-même son identifiant : on le retrouve par son journal.
    if (speaksCodex(kind) && !sessionId) {
      const stop = agentShells.watchCodexSession(
        root,
        started,
        () => new Set(known.flatMap((item) => (item.sessionId ? [item.sessionId] : []))),
        (id) => {
          sessionWatchers.delete(record.id)
          void agentShells.patch(dir, root, record.id, { sessionId: id }).then(notify, notify)
        }
      )
      sessionWatchers.set(record.id, stop)
    }
    if (!argvOk && task) {
      ws.terminals.pasteWhenReady(session.id, bracketedPaste(task), 1500, 30_000, spec.submit)
    }

    notify()
    const dim = (line: string): string => `\x1b[2m${line}\x1b[0m\r\n`
    const resumed = Boolean(sessionId && !assign)
    // Les drapeaux de permission tels qu'ils sont partis : vérifiables à l'écran, sans lire
    // `ps`. « yolo » doit se lire `--permission-mode=bypassPermissions …` ici.
    const flags = nativePermission(kind, spec.permission).join(" ")
    const banner =
      dim(`Zyvro · ${kind}${spec.model ? ` · ${spec.model}` : ""} · ${spec.permission} · ${resumed ? "resuming" : "new"} session${sessionId ? ` ${sessionId.slice(0, 8)}` : ""}`) +
      (flags ? dim(`permission flags: ${flags}`) : dim("permission flags: none (the harness's default)")) +
      (notice ? dim(notice) : "") +
      (hostNotice ? dim(hostNotice) : "") +
      (task && !argvOk ? dim("Your task is pasted into the prompt below: read it, then press Enter.") : "") +
      (session.banner ?? "")
    return { ...session, banner, record }
  })

  // Changer le modèle d'une session du MÊME harnais : on arrête l'agent s'il tourne et on
  // note le nouveau modèle sur l'enregistrement ; la fenêtre rouvre ensuite la session
  // (`--resume`), qui relit sa configuration d'ici. Un autre harnais ne passe pas par là :
  // c'est un nouvel agent qui prend la suite (`handoff`).
  ipcMain.handle("agentshell:switch", async (event, id: string, changes: unknown) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    const dir = agentShellsDir()
    const record = (await agentShells.load(dir, root)).find((item) => item.id === String(id))
    if (!record) throw new Error("That agent session is no longer in the list.")
    const wanted = (changes && typeof changes === "object" ? changes : {}) as { model?: unknown; effort?: unknown }
    const model = typeof wanted.model === "string" && wanted.model.trim() ? wanted.model.trim().slice(0, 256) : null
    const effort = supportsEffort(record.kind) && (EFFORTS as readonly string[]).includes(wanted.effort as string) ? (wanted.effort as (typeof EFFORTS)[number]) : null
    // Codex ne dit sa session qu'au premier échange, et le sondage qui l'attend
    // s'arrête avec l'onglet : on la retrouve ICI, avant d'arrêter l'agent, sinon la
    // reprise repartirait d'une session neuve.
    let sessionId = record.sessionId
    if (!sessionId && speaksCodex(record.kind)) {
      sessionId = agentShells.findCodexSession(root, Date.parse(record.createdAt) - 5000, takenSessions(await agentShells.load(dir, root), record.id))
    }
    // Arrêté sans le noter « fermé » : il va être rouvert aussitôt. Arrêté pour de
    // bon, même chez l'hôte : s'y rattacher garderait l'ancien modèle.
    const live = ws.terminals.byAgentShell(record.id)
    if (live) ws.terminals.stop(live)
    await stopHosted(record.id)
    await agentShells.patch(dir, root, record.id, { model, effort, ...(sessionId ? { sessionId } : {}) })
    if (!event.sender.isDestroyed()) event.sender.send("agentshell:changed")
    return true
  })

  ipcMain.handle("agentshell:list", async (event) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    return { records: await agentShells.load(agentShellsDir(), root), live: [...liveAgentShells(ws, root)] }
  })

  // Ce qui était ouvert quand l'application s'est arrêtée, et ne l'est plus.
  ipcMain.handle("agentshell:restorable", async (event, max: unknown, forDir?: unknown) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    // Demandé pour un dossier qui n'est plus l'actif (on a changé de projet
    // pendant l'aller-retour) : rien, plutôt que les sessions d'un autre projet
    // rangées dans celui-ci. La fenêtre redemandera en y revenant.
    if (typeof forDir === "string" && forDir && path.resolve(forDir) !== path.resolve(root)) return null
    const limit = typeof max === "number" && Number.isFinite(max) ? Math.max(0, Math.min(MAX_RESTORE, Math.floor(max))) : MAX_RESTORE
    return toRestore(await agentShells.load(agentShellsDir(), root), liveAgentShells(ws, root), limit)
  })

  ipcMain.handle("agentshell:rename", async (event, id: string, name: string) => {
    const { ws } = requireWorkspace(event)
    const clean = String(name ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 60)
    await agentShells.patch(agentShellsDir(), requireRoot(ws), String(id), { name: clean })
    if (!event.sender.isDestroyed()) event.sender.send("agentshell:changed")
    return true
  })

  // Nommer une session par la première demande qu'on y a tapée (shared/agentShell,
  // typedLine) — seulement si elle n'a ni nom choisi ni tâche de départ : un nom
  // donné à la main n'est jamais remplacé.
  ipcMain.handle("agentshell:auto-title", async (event, id: string, text: string) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    const title = titleFromTyped(String(text ?? ""))
    if (!title) return false
    let changed = false
    await agentShells.update(agentShellsDir(), root, (all) =>
      all.map((item) => {
        if (item.id !== String(id) || item.name.trim() || item.prompt.trim()) return item
        changed = true
        return { ...item, prompt: title, updatedAt: new Date().toISOString() }
      })
    )
    if (changed && !event.sender.isDestroyed()) event.sender.send("agentshell:changed")
    return changed
  })

  ipcMain.handle("agentshell:forget", async (event, id: string) => {
    const { ws } = requireWorkspace(event)
    const root = requireRoot(ws)
    // Oublier une session qui tourne l'arrête : sa ligne a disparu, son
    // processus n'a plus de nom.
    const live = ws.terminals.byAgentShell(String(id))
    if (live) ws.terminals.stop(live)
    await stopHosted(String(id))
    await agentShells.forget(agentShellsDir(), root, String(id))
    if (!event.sender.isDestroyed()) event.sender.send("agentshell:changed")
    return true
  })

  // Arrêter une session qui se réveille toute seule. Le bouton du panneau, et
  // ce que `ScheduleWakeup {stop:true}` demande depuis le flux.
  // Arrêter les tâches de fond d'une conversation garée (main/agent.ts).
  ipcMain.handle("agent:stop-background", async (event, conversationId: string) => {
    const { ws } = requireWorkspace(event)
    return ws.agent.stopBackground(String(conversationId))
  })

  ipcMain.handle("agent:background-output", async (event, taskId: string) => {
    const { ws } = requireWorkspace(event)
    return ws.agent.backgroundOutput(String(taskId))
  })

  ipcMain.handle("agent:unschedule", async (event, conversationId: string) => {
    const { ws } = requireWorkspace(event)
    ws.agent.unschedule(String(conversationId))
    return true
  })

  // Glisser un message dans un tour en cours (Claude, Codex). Faux quand ce
  // n'est pas possible : la fenêtre le garde pour le tour suivant.
  ipcMain.handle("agent:steer", async (event, id: string, text: string) => {
    const { ws } = requireWorkspace(event)
    return ws.agent.steer(String(id), String(text ?? ""))
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
    // Les tours du projet affiché seulement : la fenêtre en tient plusieurs, et
    // ceux des autres appartiennent à leurs propres chats.
    return ws.agent.running(requireRoot(ws))
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
  // ---------- le bouton bug ----------
  //
  // Le rendu envoie sa description et son propre état ; ce côté y ajoute ce
  // que lui seul tient — les tours de CHAQUE fenêtre, la machine, le journal
  // des erreurs — masque les secrets connus, et envoie.
  ipcMain.handle("bug:report", async (event, kind: unknown, description: unknown, renderer: unknown) => {
    requireWorkspace(event)
    const windows = studioWindows().map((win) => {
      const ws = workspaces.get(win)
      return { windowId: win.id, focused: win.isFocused(), root: ws?.root ?? null, agent: ws?.agent.debugSnapshot() ?? null }
    })
    const own = windows.find((w) => w.windowId === BrowserWindow.fromWebContents(event.sender)?.id)
    return await sendBugReport(
      { kind: kind === "crash" ? "crash" : "manual", description: typeof description === "string" ? description : "", renderer },
      // `turns` à la racine, pour que la réduction de taille les trouve.
      { turns: (own?.agent as { turns?: unknown[] } | null)?.turns ?? [], windows },
      reportBug
    )
  })
  // Une erreur vue par le rendu : elle entre au même journal.
  ipcMain.handle("bug:incident", async (event, source: unknown, message: unknown) => {
    requireWorkspace(event)
    recordIncident(`renderer:${String(source).slice(0, 40)}`, String(message))
    return true
  })
  ipcMain.handle("bug:unreported", async () => unreportedIncidents())

  ipcMain.handle("account:current", async () => currentAccount())
  ipcMain.handle("account:sign-in", async (_event, email: string, password: string) =>
    signIn(String(email), String(password))
  )
  ipcMain.handle("account:sign-out", async () => {
    await signOut()
    return null
  })

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

// cleanAnswers : ce que le rendu a envoyé, réduit à la forme attendue. Une
// valeur d'une autre forme n'est pas une réponse : elle disparaît, et la
// question reste sans réponse plutôt que d'en recevoir une fausse.
function cleanAnswers(answers: unknown): QuestionAnswers | undefined {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined
  const out: QuestionAnswers = {}
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    out[key] = value.filter((v): v is string => typeof v === "string")
  }
  return out
}
