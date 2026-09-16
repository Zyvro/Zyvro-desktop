import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"

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
export type FileRead = { path: string; text: string; truncated: boolean } | { path: string; binary: true }
export type AgentKind = "claude" | "codex"
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
}

const api = {
  platform: process.platform,

  project: {
    choose: (): Promise<string | null> => ipcRenderer.invoke("project:choose"),
    create: (): Promise<string | null> => ipcRenderer.invoke("project:create"),
    open: (dir: string): Promise<OpenResult> => ipcRenderer.invoke("project:open", dir),
    current: (): Promise<OpenResult | null> => ipcRenderer.invoke("project:current"),
    close: (): Promise<boolean> => ipcRenderer.invoke("project:close"),
    recents: (): Promise<Recent[]> => ipcRenderer.invoke("project:recents"),
    forgetRecents: (): Promise<Recent[]> => ipcRenderer.invoke("project:forget-recents"),
  },

  files: {
    list: (relative: string): Promise<DirEntry[]> => ipcRenderer.invoke("files:list", relative),
    read: (relative: string): Promise<FileRead> => ipcRenderer.invoke("files:read", relative),
    write: (relative: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke("files:write", relative, text),
    create: (relative: string, kind: "file" | "directory"): Promise<boolean> =>
      ipcRenderer.invoke("files:create", relative, kind),
    rename: (from: string, to: string): Promise<boolean> => ipcRenderer.invoke("files:rename", from, to),
    remove: (relative: string): Promise<boolean> => ipcRenderer.invoke("files:delete", relative),
    reveal: (relative: string): Promise<boolean> => ipcRenderer.invoke("shell:reveal", relative),
    pick: (request: { save?: boolean; title?: string; current?: string }): Promise<string | null> =>
      ipcRenderer.invoke("files:pick", request),
  },

  terminal: {
    create: (cols: number, rows: number): Promise<{ id: string; pty: boolean }> =>
      ipcRenderer.invoke("terminal:create", cols, rows),
    write: (id: string, data: string): Promise<boolean> => ipcRenderer.invoke("terminal:write", id, data),
    resize: (id: string, cols: number, rows: number): Promise<boolean> =>
      ipcRenderer.invoke("terminal:resize", id, cols, rows),
    dispose: (id: string): Promise<boolean> => ipcRenderer.invoke("terminal:dispose", id),
    onData: (cb: (p: { id: string; data: string }) => void): Unsubscribe => on("terminal:data", cb),
    onExit: (cb: (p: { id: string; code: number }) => void): Unsubscribe => on("terminal:exit", cb),
  },

  agent: {
    send: (
      kind: AgentKind,
      prompt: string,
      workflows: WorkflowRef[],
      conversationId: string,
      model: string | null,
      images: string[]
    ): Promise<string> =>
      ipcRenderer.invoke("agent:send", kind, prompt, { workflows }, conversationId, model, images),
    attach: (
      conversationId: string,
      name: string,
      bytes: Uint8Array
    ): Promise<{ id: string; name: string; mime: string }> =>
      ipcRenderer.invoke("agent:attach", conversationId, name, bytes),
    detach: (conversationId: string, id: string): Promise<void> =>
      ipcRenderer.invoke("agent:detach", conversationId, id),
    models: (kind: AgentKind): Promise<string[]> => ipcRenderer.invoke("agent:models", kind),
    conversations: (): Promise<Conversation[]> => ipcRenderer.invoke("agent:conversations"),
    remember: (conversation: Conversation): Promise<void> =>
      ipcRenderer.invoke("agent:remember", conversation),
    forget: (id: string): Promise<void> => ipcRenderer.invoke("agent:forget", id),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke("agent:cancel", id),
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
      cb: (p: { id: string; callId: string; output: string; isError: boolean }) => void
    ): Unsubscribe => on("agent:tool-result", cb),
    onModel: (cb: (p: { id: string; conversationId: string; model: string }) => void): Unsubscribe =>
      on("agent:model", cb),
    onError: (cb: (p: { id: string; message: string }) => void): Unsubscribe => on("agent:error", cb),
    onDone: (cb: (p: { id: string }) => void): Unsubscribe => on("agent:done", cb),
  },

  account: {
    current: (): Promise<Account | null> => ipcRenderer.invoke("account:current"),
    signIn: (email: string, password: string): Promise<Account> =>
      ipcRenderer.invoke("account:sign-in", email, password),
    signOut: (): Promise<null> => ipcRenderer.invoke("account:sign-out"),
  },

  store: {
    nodes: (q: string): Promise<StoreListing[]> => ipcRenderer.invoke("store:nodes", q),
    workflows: (q: string): Promise<StoreWorkflow[]> => ipcRenderer.invoke("store:workflows", q),
    readPack: (name: string, version?: string): Promise<StorePack> =>
      ipcRenderer.invoke("store:read-pack", name, version),
    installPack: (name: string, version?: string): Promise<InstallResult> =>
      ipcRenderer.invoke("store:install-pack", name, version),
    installWorkflow: (name: string): Promise<InstallResult> =>
      ipcRenderer.invoke("store:install-workflow", name),
    installedPacks: (): Promise<InstalledPack[]> => ipcRenderer.invoke("store:installed-packs"),
    publishPack: (name: string, password: string): Promise<unknown> =>
      ipcRenderer.invoke("store:publish-pack", name, password),
    publishWorkflow: (payload: { id: string; name: string; description: string; graph: unknown }): Promise<unknown> =>
      ipcRenderer.invoke("store:publish-workflow", payload),
  },

  // Git. The shapes are imported from the main process rather than restated
  // here, the same rule the store types follow two blocks up and for the same
  // reason: a description of somebody else's data that lives in two places
  // disagrees with itself eventually.
  git: {
    status: (): Promise<GitStatus | NoRepository> => ipcRenderer.invoke("git:status"),
    init: (): Promise<void> => ipcRenderer.invoke("git:init"),
    stage: (paths: string[]): Promise<void> => ipcRenderer.invoke("git:stage", paths),
    unstage: (paths: string[]): Promise<void> => ipcRenderer.invoke("git:unstage", paths),
    discard: (paths: string[]): Promise<void> => ipcRenderer.invoke("git:discard", paths),
    commit: (message: string, options: CommitOptions = {}): Promise<void> =>
      ipcRenderer.invoke("git:commit", message, options),
    diff: (path: string, staged: boolean): Promise<string> => ipcRenderer.invoke("git:diff", path, staged),
    fileAt: (path: string, revision: string): Promise<string> =>
      ipcRenderer.invoke("git:file-at", path, revision),
    log: (limit?: number): Promise<LogEntry[]> => ipcRenderer.invoke("git:log", limit),
    branches: (): Promise<string[]> => ipcRenderer.invoke("git:branches"),
    checkout: (branch: string): Promise<void> => ipcRenderer.invoke("git:checkout", branch),
    createBranch: (name: string): Promise<void> => ipcRenderer.invoke("git:create-branch", name),
    fetch: (): Promise<void> => ipcRenderer.invoke("git:fetch"),
    pull: (): Promise<void> => ipcRenderer.invoke("git:pull"),
    push: (): Promise<void> => ipcRenderer.invoke("git:push"),
    pushTo: (remote: string, setUpstream: boolean): Promise<void> =>
      ipcRenderer.invoke("git:push-to", remote, setUpstream),
    pushTags: (): Promise<void> => ipcRenderer.invoke("git:push-tags"),
    remotes: (): Promise<Remote[]> => ipcRenderer.invoke("git:remotes"),
    addRemote: (name: string, url: string): Promise<void> => ipcRenderer.invoke("git:add-remote", name, url),
    removeRemote: (name: string): Promise<void> => ipcRenderer.invoke("git:remove-remote", name),
    stashList: (): Promise<Stash[]> => ipcRenderer.invoke("git:stash-list"),
    stash: (message: string, includeUntracked: boolean): Promise<void> =>
      ipcRenderer.invoke("git:stash", message, includeUntracked),
    stashPop: (index: number): Promise<void> => ipcRenderer.invoke("git:stash-pop", index),
    stashApply: (index: number): Promise<void> => ipcRenderer.invoke("git:stash-apply", index),
    stashDrop: (index: number): Promise<void> => ipcRenderer.invoke("git:stash-drop", index),
    tags: (): Promise<string[]> => ipcRenderer.invoke("git:tags"),
    createTag: (name: string, message: string): Promise<void> =>
      ipcRenderer.invoke("git:create-tag", name, message),
    deleteTag: (name: string): Promise<void> => ipcRenderer.invoke("git:delete-tag", name),
    renameBranch: (from: string, to: string): Promise<void> =>
      ipcRenderer.invoke("git:rename-branch", from, to),
    deleteBranch: (name: string, force: boolean): Promise<void> =>
      ipcRenderer.invoke("git:delete-branch", name, force),
    output: (): Promise<GitCommandLog[]> => ipcRenderer.invoke("git:output"),
    agent: (): Promise<"claude" | "codex" | null> => ipcRenderer.invoke("git:agent"),
    suggestMessage: (): Promise<string> => ipcRenderer.invoke("git:suggest-message"),
    clone: (url: string): Promise<string | null> => ipcRenderer.invoke("git:clone", url),
  },

  workflows: {
    chooseSource: (): Promise<Importable | null> => ipcRenderer.invoke("workflows:choose-source"),
  },

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("shell:open-external", url),

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
    onToggleAgent: (cb: () => void): Unsubscribe => on("menu:toggle-agent", cb),
  },
}

export type ZyvroBridge = typeof api

contextBridge.exposeInMainWorld("zyvro", api)
