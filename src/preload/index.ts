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
export type StoreListing = {
  name: string
  version: string
  description: string
  author: string
  capabilities: string[]
  nodeTypes?: string[]
  updatedAt: string
}
export type StoreSource = { path: string; code: string }
export type StorePack = StoreListing & {
  manifest?: Record<string, unknown>
  sources: StoreSource[]
}
export type StoreWorkflow = {
  name: string
  description: string
  author: string
  graph: unknown
  requires: { name: string; version: string }[]
  updatedAt: string
}
export type InstallResult = { workflow?: string; packs: { name: string; version: string }[] }
export type InstalledPack = {
  name: string
  version: string
  description: string
  author: string
  capabilities: string[]
  sources: StoreSource[]
}
export type EngineManifest = {
  version: string
  platform: string
  size: number
  sha256: string
  released_at: string
  notes?: string
  signature: string
  url: string
}
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current"; version: string; checkedAt: string }
  | { status: "available"; current: string; manifest: EngineManifest; checkedAt: string }
  | { status: "downloading"; manifest: EngineManifest; receivedBytes: number; totalBytes: number }
  | { status: "installed"; version: string; restartRequired: true }
  | { status: "failed"; message: string; checkedAt: string }

const api = {
  platform: process.platform,

  project: {
    choose: (): Promise<string | null> => ipcRenderer.invoke("project:choose"),
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
    send: (kind: AgentKind, prompt: string, workflows: WorkflowRef[]): Promise<string> =>
      ipcRenderer.invoke("agent:send", kind, prompt, { workflows }),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke("agent:cancel", id),
    onText: (cb: (p: { id: string; text: string }) => void): Unsubscribe => on("agent:text", cb),
    onTool: (cb: (p: { id: string; tool: string }) => void): Unsubscribe => on("agent:tool", cb),
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
    publishPack: (name: string): Promise<unknown> => ipcRenderer.invoke("store:publish-pack", name),
    publishWorkflow: (payload: { name: string; description: string; graph: unknown }): Promise<unknown> =>
      ipcRenderer.invoke("store:publish-workflow", payload),
  },

  engineUpdate: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke("engine-update:state"),
    check: (): Promise<UpdateState> => ipcRenderer.invoke("engine-update:check"),
    // Takes no arguments on purpose: the main process installs the release it
    // verified itself, never one named by this window.
    install: (): Promise<UpdateState> => ipcRenderer.invoke("engine-update:install"),
    dismiss: (): Promise<UpdateState> => ipcRenderer.invoke("engine-update:dismiss"),
    onState: (cb: (state: UpdateState) => void): Unsubscribe => on("engine-update:state", cb),
  },

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("shell:open-external", url),

  menu: {
    onOpenProject: (cb: () => void): Unsubscribe => on("menu:open-project", cb),
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
