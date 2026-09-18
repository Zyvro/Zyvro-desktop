import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron"

// This is the entire surface the renderer gets. Every entry is a named
// operation, never a path to a general capability: no `invoke(channel, ...)`
// passthrough, because that would hand a compromised renderer the whole main
// process.

type Unsubscribe = () => void

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export type DirEntry = { name: string; path: string; kind: "file" | "directory" }
export type DaemonInfo = { ready: true; port: number; token: string; project: string; origin: string }
export type OpenResult = { project: string; name: string; daemon: DaemonInfo }
// La forme que le rendu reçoit. Redite ici parce qu'il ne peut pas importer un
// module du processus principal, et c'est le contrat entre les deux.
export type FileRead =
  | { path: string; text: string; truncated: boolean }
  | { path: string; image: { mime: string; uri: string } }
  | { path: string; binary: true }
import type { AgentKind } from "../shared/harness"
export type { AgentKind }

// Les formes de la recherche traversent le pont : elles sont redites ici parce
// que le rendu ne peut pas importer un module du processus principal, et la
// forme est le contrat entre les deux.
export type SearchQuery = {
  query: string
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
  include?: string
  exclude?: string
}
export type SearchMatch = { line: number; column: number; length: number; text: string }
export type SearchResult = {
  files: { path: string; matches: SearchMatch[] }[]
  matches: number
  truncated: boolean
}
export type ReplaceTarget = { path: string; line: number; column: number; length: number }
export type ReplaceResult = { files: number; matches: number; skipped: number }

// Ce que l'agent a le droit de faire : le type traverse le pont, sa valeur vit
// dans le module partagé. Le rendu l'importe de là et pas d'ici — ce fichier
// importe `electron`, et le prendre pour une constante ferait entrer electron
// dans le paquet du rendu.
import type { Permission } from "../shared/permission"
import type { Spent } from "../main/agent"
export type { Spent }
export type { Permission }
export type WorkflowRef = { id: string; name: string; description?: string }
export type Recent = { path: string; name: string; openedAt: string }
export type Account = { id: string; email: string; name: string }
// The store's wire shapes live in src/main/store.ts and are imported, never
// copied. They were copied, and the copies drifted: this file declared a
// workflow with `author`, `graph` and `updatedAt` where the server sends
// `publisher_name`, `graph_json` and `created_at`, so every card read "by
// unknown" and the type agreed with the mistake. A type that describes someone
// else's JSON has to have exactly one declaration.
//
// Type-only imports, so nothing from the main process is pulled into the
// preload bundle.
import type {
  StoreListing,
  StoreSource,
  StorePack,
  StoreWorkflow,
  StorePreview,
  StoreDependency,
  InstallResult,
  InstalledPack,
} from "../main/store"
import type { PublisherVerdict } from "../main/knownpublishers"
import type { Conversation, StoredMessage, StoredTool } from "../main/conversations"
import type { PlanItem, ToolShape } from "../main/tooltalk"
import type { Importable, ImportableWorkflow } from "../main/importing"
import type { HostedWorkflow, SharedWorkflow } from "../main/sharing"
import type {
  Change,
  ChangeStatus,
  CommitOptions,
  GitCommandLog,
  GitStatus,
  LogEntry,
  NoRepository,
  Remote,
  Stash,
} from "../main/git"

export type {
  StoreListing,
  StoreSource,
  StorePack,
  StoreWorkflow,
  StorePreview,
  StoreDependency,
  InstallResult,
  InstalledPack,
  PublisherVerdict,
  Change,
  ChangeStatus,
  CommitOptions,
  GitCommandLog,
  GitStatus,
  LogEntry,
  NoRepository,
  Remote,
  Stash,
  Conversation,
  StoredMessage,
  StoredTool,
  PlanItem,
  ToolShape,
  Importable,
  ImportableWorkflow,
  HostedWorkflow,
  SharedWorkflow,
}

// invoke : `ipcRenderer.invoke`, sans la plomberie dans le message.
//
// Electron enveloppe toute erreur venue du processus principal :
//
//     Error invoking remote method 'shots:share': Error: Sign in to publish
//     to the store.
//
// Le rendu affiche `err.message` tel quel — c'est ce que font une douzaine de
// panneaux, et c'est la bonne chose à faire : ces phrases sont écrites pour
// être lues. Elles arrivaient précédées du nom d'un canal que personne n'a à
// connaître, ce qui fait passer une consigne claire pour une trace technique,
// et une fenêtre qui dit « connectez-vous pour publier » pour un bogue.
//
// Ici et pas dans les panneaux : le pont est le passage obligé de toutes ces
// erreurs. Le faire douze fois voudrait dire l'oublier au treizième.
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/

function plainMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (!IPC_WRAPPER.test(raw)) return raw
  // Une fois l'enveloppe retirée, le nom de la classe reste collé devant la
  // phrase — « Error: », « TypeError: » — et n'apprend rien non plus.
  const inner = raw.replace(IPC_WRAPPER, "").replace(/^[A-Za-z]*Error:\s*/, "")
  return inner || raw
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then(
    (value) => value as T,
    (err: unknown) => {
      // L'original garde le canal et la trace, pour qui va les chercher dans
      // la console ; le message, lui, est la phrase.
      throw new Error(plainMessage(err), { cause: err })
    }
  )
}

const api = {
  platform: process.platform,

  project: {
    choose: (): Promise<string | null> => invoke("project:choose"),
    create: (): Promise<string | null> => invoke("project:create"),
    open: (dir: string): Promise<OpenResult> => invoke("project:open", dir),
    current: (): Promise<OpenResult | null> => invoke("project:current"),
    close: (): Promise<boolean> => invoke("project:close"),
    recents: (): Promise<Recent[]> => invoke("project:recents"),
    forgetRecents: (): Promise<Recent[]> => invoke("project:forget-recents"),
  },

  files: {
    list: (relative: string): Promise<DirEntry[]> => invoke("files:list", relative),
    read: (relative: string): Promise<FileRead> => invoke("files:read", relative),
    write: (relative: string, text: string): Promise<boolean> =>
      invoke("files:write", relative, text),
    // L'arbre dit ce qu'il ouvre et ce qu'il replie ; le principal ne surveille
    // que ça. `onChanged` ne dit pas ce qui a changé, seulement où : le rendu
    // sait relire un dossier, et une liste de différences à appliquer à la main
    // serait une seconde vérité à côté de celle qui marche.
    // Le chemin d'un fichier lâché depuis le Finder.
    //
    // `File.path` n'existe plus : Electron l'a retiré en 32, et le rendu n'a
    // aucun autre moyen de savoir d'où vient un fichier déposé — un `File` est
    // du contenu, pas un emplacement. `webUtils.getPathForFile` est le
    // remplacement, et il vit ici parce qu'il vit dans `electron`.
    droppedPath: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        // Un fichier qui ne vient pas du disque — une image collée depuis une
        // page web — n'a pas de chemin, et ce n'est pas une erreur.
        return ""
      }
    },
    watch: (relative: string): Promise<boolean> => invoke("files:watch", relative),
    unwatch: (relative: string): Promise<boolean> => invoke("files:unwatch", relative),
    onChanged: (cb: (payload: { dir: string }) => void): Unsubscribe => on("files:changed", cb),

    create: (relative: string, kind: "file" | "directory"): Promise<boolean> =>
      invoke("files:create", relative, kind),
    rename: (from: string, to: string): Promise<boolean> => invoke("files:rename", from, to),
    remove: (relative: string): Promise<boolean> => invoke("files:delete", relative),
    reveal: (relative: string): Promise<boolean> => invoke("shell:reveal", relative),
    pick: (request: { save?: boolean; title?: string; current?: string }): Promise<string | null> =>
      invoke("files:pick", request),
  },

  // Chercher dans le projet, et remplacer — dans les fichiers qu'on n'a pas
  // ouverts, ce qui est le propre de cette fonction.
  search: {
    find: (query: SearchQuery): Promise<SearchResult> => invoke("search:find", query),
    replace: (
      query: SearchQuery,
      replacement: string,
      targets: ReplaceTarget[] | null
    ): Promise<ReplaceResult> => invoke("search:replace", query, replacement, targets),
  },

  terminal: {
    create: (cols: number, rows: number): Promise<{ id: string; pty: boolean; banner?: string }> =>
      invoke("terminal:create", cols, rows),
    write: (id: string, data: string): Promise<boolean> => invoke("terminal:write", id, data),
    resize: (id: string, cols: number, rows: number): Promise<boolean> =>
      invoke("terminal:resize", id, cols, rows),
    dispose: (id: string): Promise<boolean> => invoke("terminal:dispose", id),
    onData: (cb: (p: { id: string; data: string }) => void): Unsubscribe => on("terminal:data", cb),
    onExit: (cb: (p: { id: string; code: number }) => void): Unsubscribe => on("terminal:exit", cb),
  },

  // Le navigateur de test. Le rendu monte la vue et annonce son contenu ; le
  // processus principal lui demande d'ouvrir l'onglet quand un agent le
  // réclame.
  browser: {
    attach: (contentsId: number, tabId: string): Promise<boolean> =>
      invoke("browser:attach", contentsId, tabId),
    visited: (contentsId: number, url: string): Promise<boolean> =>
      invoke("browser:visited", contentsId, url),
    devtools: (
      contentsId: number,
      open: boolean,
      bounds: { x: number; y: number; width: number; height: number } | null
    ): Promise<boolean> => invoke("browser:devtools", contentsId, open, bounds),
    devtoolsBounds: (
      contentsId: number,
      bounds: { x: number; y: number; width: number; height: number } | null
    ): Promise<boolean> => invoke("browser:devtools-bounds", contentsId, bounds),
    // `view` dit laquelle : un identifiant d'onglet pour piloter celle-là, la
    // chaîne vide pour réutiliser celle qui est ouverte, « new » pour en ouvrir
    // une de plus.
    onOpen: (cb: (payload: { view: string }) => void): Unsubscribe => on("browser:open", cb),
    // Le processus principal demande la vue d'accueil des outils avant de
    // pouvoir les y dessiner : c'est le rendu qui la monte.
    onDevtoolsOpen: (cb: (payload: { view: string }) => void): Unsubscribe => on("browser:devtools-open", cb),
    onDevtoolsClosed: (cb: (payload: { view: string }) => void): Unsubscribe => on("browser:devtools-closed", cb),
  },

  agent: {
    send: (
      kind: AgentKind,
      prompt: string,
      workflows: WorkflowRef[],
      conversationId: string,
      model: string | null,
      images: string[],
      permission: Permission
    ): Promise<string> =>
      invoke("agent:send", kind, prompt, { workflows, permission }, conversationId, model, images),
    // Une demande de permission venue de la CLI, et la réponse de la personne.
    onPermission: (
      cb: (payload: { id: string; tool: string; input: Record<string, unknown> }) => void
    ): Unsubscribe => on("agent:permission", cb),
    answerPermission: (id: string, allow: boolean): Promise<boolean> =>
      invoke("agent:permission-answer", id, allow),
    attach: (
      conversationId: string,
      name: string,
      bytes: Uint8Array
    ): Promise<{ id: string; name: string; mime: string }> =>
      invoke("agent:attach", conversationId, name, bytes),
    detach: (conversationId: string, id: string): Promise<void> =>
      invoke("agent:detach", conversationId, id),
    models: (kind: AgentKind): Promise<string[]> => invoke("agent:models", kind),
    // Ce qu'une puce affiche d'elle-même. Une adresse `data:`, ou rien quand le
    // fichier n'est plus là.
    thumbnail: (conversationId: string, id: string): Promise<string | null> =>
      invoke("agent:thumbnail", conversationId, id),
    conversations: (): Promise<Conversation[]> => invoke("agent:conversations"),
    remember: (conversation: Conversation): Promise<void> =>
      invoke("agent:remember", conversation),
    forget: (id: string): Promise<void> => invoke("agent:forget", id),
    cancel: (id: string): Promise<boolean> => invoke("agent:cancel", id),
    onText: (cb: (p: { id: string; text: string }) => void): Unsubscribe => on("agent:text", cb),
    onTool: (
      cb: (p: {
        id: string
        callId: string
        name: string
        running: string
        done: string
        shape: ToolShape
        detail: string
        plan: PlanItem[]
      }) => void
    ): Unsubscribe => on("agent:tool", cb),
    onToolResult: (
      cb: (p: {
        id: string
        callId: string
        output: string
        isError: boolean
        // Ce que l'outil a MONTRÉ. Des identifiants, pas des octets : l'image
        // est déjà écrite à côté de la conversation, et se redemande par
        // `thumbnail`.
        images: { id: string; name: string }[]
      }) => void
    ): Unsubscribe => on("agent:tool-result", cb),
    onModel: (cb: (p: { id: string; conversationId: string; model: string }) => void): Unsubscribe =>
      on("agent:model", cb),
    // Ce qu'un tour a dépensé, tel que le CLI le rapporte à la fin. Il arrive
    // avec le flux : rien n'est demandé en plus pour l'obtenir.
    onUsage: (cb: (p: { id: string } & Spent) => void): Unsubscribe => on("agent:usage", cb),
    onError: (cb: (p: { id: string; message: string }) => void): Unsubscribe => on("agent:error", cb),
    onDone: (cb: (p: { id: string }) => void): Unsubscribe => on("agent:done", cb),
  },

  account: {
    current: (): Promise<Account | null> => invoke("account:current"),
    signIn: (email: string, password: string): Promise<Account> =>
      invoke("account:sign-in", email, password),
    signOut: (): Promise<null> => invoke("account:sign-out"),
  },

  store: {
    nodes: (q: string): Promise<StoreListing[]> => invoke("store:nodes", q),
    workflows: (q: string): Promise<StoreWorkflow[]> => invoke("store:workflows", q),
    readPack: (name: string, version?: string): Promise<StorePack> =>
      invoke("store:read-pack", name, version),
    installPack: (name: string, version?: string): Promise<InstallResult> =>
      invoke("store:install-pack", name, version),
    installWorkflow: (name: string): Promise<InstallResult> =>
      invoke("store:install-workflow", name),
    installedPacks: (): Promise<InstalledPack[]> => invoke("store:installed-packs"),
    publishPack: (name: string, password: string): Promise<unknown> =>
      invoke("store:publish-pack", name, password),
    publishWorkflow: (payload: { id: string; name: string; description: string; graph: unknown }): Promise<unknown> =>
      invoke("store:publish-workflow", payload),
  },

  // Git. The shapes are imported from the main process rather than restated
  // here, the same rule the store types follow two blocks up and for the same
  // reason: a description of somebody else's data that lives in two places
  // disagrees with itself eventually.
  // La capture d'une zone. Le rendu ne peut pas photographier sa propre
  // fenêtre — c'est le processus principal qui la possède — donc il décrit la
  // région et reçoit en retour où l'image est partie.
  shots: {
    // Trois temps : on photographie, la fenêtre demande quoi en faire, puis on
    // garde ou on partage. Les octets restent côté principal entre les deux —
    // les faire traverser le pont deux fois pour rien coûterait quelques
    // mégaoctets à chaque capture.
    capture: (
      rect: { x: number; y: number; width: number; height: number },
      label?: string
    ): Promise<{ preview: string; bytes: number }> => invoke("shots:capture", rect, label),
    save: (): Promise<string> => invoke("shots:save"),
    share: (): Promise<string> => invoke("shots:share"),
  },

  git: {
    status: (): Promise<GitStatus | NoRepository> => invoke("git:status"),
    init: (): Promise<void> => invoke("git:init"),
    stage: (paths: string[]): Promise<void> => invoke("git:stage", paths),
    unstage: (paths: string[]): Promise<void> => invoke("git:unstage", paths),
    discard: (paths: string[]): Promise<void> => invoke("git:discard", paths),
    commit: (message: string, options: CommitOptions = {}): Promise<void> =>
      invoke("git:commit", message, options),
    diff: (path: string, staged: boolean): Promise<string> => invoke("git:diff", path, staged),
    fileAt: (path: string, revision: string): Promise<string> =>
      invoke("git:file-at", path, revision),
    log: (limit?: number): Promise<LogEntry[]> => invoke("git:log", limit),
    branches: (): Promise<string[]> => invoke("git:branches"),
    checkout: (branch: string): Promise<void> => invoke("git:checkout", branch),
    createBranch: (name: string): Promise<void> => invoke("git:create-branch", name),
    fetch: (): Promise<void> => invoke("git:fetch"),
    pull: (): Promise<void> => invoke("git:pull"),
    push: (): Promise<void> => invoke("git:push"),
    pushTo: (remote: string, setUpstream: boolean): Promise<void> =>
      invoke("git:push-to", remote, setUpstream),
    pushTags: (): Promise<void> => invoke("git:push-tags"),
    remotes: (): Promise<Remote[]> => invoke("git:remotes"),
    addRemote: (name: string, url: string): Promise<void> => invoke("git:add-remote", name, url),
    removeRemote: (name: string): Promise<void> => invoke("git:remove-remote", name),
    stashList: (): Promise<Stash[]> => invoke("git:stash-list"),
    stash: (message: string, includeUntracked: boolean): Promise<void> =>
      invoke("git:stash", message, includeUntracked),
    stashPop: (index: number): Promise<void> => invoke("git:stash-pop", index),
    stashApply: (index: number): Promise<void> => invoke("git:stash-apply", index),
    stashDrop: (index: number): Promise<void> => invoke("git:stash-drop", index),
    tags: (): Promise<string[]> => invoke("git:tags"),
    createTag: (name: string, message: string): Promise<void> =>
      invoke("git:create-tag", name, message),
    deleteTag: (name: string): Promise<void> => invoke("git:delete-tag", name),
    renameBranch: (from: string, to: string): Promise<void> =>
      invoke("git:rename-branch", from, to),
    deleteBranch: (name: string, force: boolean): Promise<void> =>
      invoke("git:delete-branch", name, force),
    output: (): Promise<GitCommandLog[]> => invoke("git:output"),
    agent: (): Promise<"claude" | "codex" | null> => invoke("git:agent"),
    suggestMessage: (): Promise<string> => invoke("git:suggest-message"),
    clone: (url: string): Promise<string | null> => invoke("git:clone", url),
  },

  workflows: {
    chooseSource: (): Promise<Importable | null> => invoke("workflows:choose-source"),
    share: (payload: { name: string; description: string; graph: unknown }): Promise<SharedWorkflow> =>
      invoke("workflows:share", payload),
    mine: (): Promise<HostedWorkflow[]> => invoke("workflows:mine"),
  },

  openExternal: (url: string): Promise<boolean> => invoke("shell:open-external", url),

  menu: {
    onOpenProject: (cb: () => void): Unsubscribe => on("menu:open-project", cb),
    onNewProject: (cb: () => void): Unsubscribe => on("menu:new-project", cb),
    onOpenPath: (cb: (dir: string) => void): Unsubscribe => on("menu:open-path", cb),
    onCloseProject: (cb: () => void): Unsubscribe => on("menu:close-project", cb),
    onForgetRecents: (cb: () => void): Unsubscribe => on("menu:forget-recents", cb),
    onToggleSidebar: (cb: () => void): Unsubscribe => on("menu:toggle-sidebar", cb),
    onNewWorkflow: (cb: () => void): Unsubscribe => on("menu:new-workflow", cb),
    onSave: (cb: () => void): Unsubscribe => on("menu:save", cb),
    onToggleTerminal: (cb: () => void): Unsubscribe => on("menu:toggle-terminal", cb),
    onFindInFile: (cb: () => void): Unsubscribe => on("menu:find-in-file", cb),
    onFindInProject: (cb: () => void): Unsubscribe => on("menu:find-in-project", cb),
    onToggleAgent: (cb: () => void): Unsubscribe => on("menu:toggle-agent", cb),
  },
}

export type ZyvroBridge = typeof api

contextBridge.exposeInMainWorld("zyvro", api)
