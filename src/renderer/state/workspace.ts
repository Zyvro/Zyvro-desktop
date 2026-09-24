import { create } from "zustand"
import type { OpenResult } from "../../preload"
import { retarget } from "../../shared/treedrop"

// The workspace is the window's whole model: which project is open, what is in
// the editor tabs, and which panels are showing. It lives in a store rather
// than in component state because the shims need to reach it from outside the
// React tree, when a shared component calls router.push.

export type Tab =
  | { kind: "welcome"; id: "welcome"; title: string }
  | { kind: "file"; id: string; path: string; title: string }
  | { kind: "graph"; id: string; workflowId: string; title: string }
  | { kind: "providers"; id: "providers"; title: string }
  | { kind: "store"; id: "store"; title: string }
  // Plusieurs vues de navigateur, comme plusieurs onglets : une page de
  // connexion d'un côté, la page qu'on teste de l'autre, et un agent qui pilote
  // celle qu'on lui nomme.
  | { kind: "browser"; id: string; title: string; url: string; icon?: string }
  // A diff is its own kind rather than a file tab with a flag: it has two sides,
  // it is read-only, and closing it must not look like closing the file.
  | { kind: "diff"; id: string; path: string; staged: boolean; title: string }
  | { kind: "gitOutput"; id: "git-output"; title: string }

export type PanelKey = "explorer" | "search" | "terminal" | "agent" | "git"

// Two ways of working, and they are genuinely two — not a set of panels that
// happen to be toggled differently.
//
// In Dev you are writing the code: tabs, a shell underneath, the agent beside
// you as a second opinion. In AI you are asking for it: the agent is the work
// surface and takes the whole middle, there is no shell, and nothing is open
// because nothing has been opened yet. Opening a file is what says "now I want
// to read this myself", and that is the moment the agent steps aside to the
// right rather than the moment you go looking for a layout button.
export type Mode = "ai" | "dev"

const MODE_KEY = "zyvro.mode"

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "ai" ? "ai" : "dev"
  } catch {
    // A window with no storage is a window that starts in Dev, which is the
    // layout that hides nothing.
    return "dev"
  }
}

// The sidebar holds one view at a time, the way every editor built on this
// layout does: clicking Source Control puts the file tree away rather than
// stacking underneath it. Two scrolling trees sharing one narrow column means
// neither has room, and the activity bar stops meaning "where am I".
//
// It is derived rather than stored separately: `panels` is still the one place
// that says what is open, so the menu item and the title-bar button keep
// working on it unchanged.
export type SidebarView = "explorer" | "search" | "git"

export function sidebarView(panels: Record<PanelKey, boolean>): SidebarView | null {
  if (panels.git) return "git"
  if (panels.search) return "search"
  if (panels.explorer) return "explorer"
  return null
}

type WorkspaceState = {
  project: OpenResult | null
  /**
   * Où le moteur travaille : le dossier du projet, ou celui d'accueil quand
   * aucun projet n'est ouvert.
   *
   * Distinct de `project`, et c'est la distinction qui compte : les shells et
   * les agents ont besoin d'un dossier, pas d'un projet. Les confondre était ce
   * qui rendait le terminal et l'agent inutilisables tant qu'on n'avait pas
   * ouvert quelque chose.
   */
  root: string | null
  opening: boolean
  openError: string

  tabs: Tab[]
  activeTabId: string
  // Unsaved editor text keyed by tab id. A file tab reads its saved contents
  // through react-query and overlays whatever is here, so "dirty" is simply
  // "this key exists and differs from what was loaded".
  drafts: Record<string, string>
  /** Les fichiers dont on a fermé l'onglet, le plus récent à la fin. */
  closedFiles: string[]

  panels: Record<PanelKey, boolean>
  mode: Mode

  setProject: (project: OpenResult | null) => void
  setRoot: (root: string | null) => void
  setOpening: (opening: boolean) => void
  setOpenError: (message: string) => void

  openFile: (path: string) => void
  openGraph: (workflowId: string, title: string) => void
  openDiff: (path: string, staged: boolean) => void
  openGitOutput: () => void
  openProviders: () => void
  openStore: () => void
  openBrowser: (request?: { url?: string; reuse?: boolean }) => string
  setBrowserPage: (id: string, url: string, title: string, icon?: string) => void
  closeTab: (id: string) => void
  /** Rouvrir le dernier fichier fermé (⌘⇧T). */
  reopenClosed: () => void
  activateTab: (id: string) => void
  renameTab: (id: string, title: string) => void
  /** Un fichier ou un dossier a changé de chemin : ses onglets et ses
   *  brouillons le suivent. */
  movePath: (from: string, to: string) => void

  setDraft: (id: string, text: string) => void
  clearDraft: (id: string) => void

  togglePanel: (key: PanelKey) => void
  setPanel: (key: PanelKey, open: boolean) => void
  setMode: (mode: Mode) => void
}

const WELCOME: Tab = { kind: "welcome", id: "welcome", title: "Welcome" }

// Les vues de navigateur sont numérotées dans l'ordre où on les ouvre, et le
// numéro ne se réutilise pas : un agent qui tient « browser:2 » ne doit pas se
// retrouver à piloter la page de quelqu'un d'autre parce qu'on a fermé la
// première.
let nextBrowserId = 1

const SIDEBAR: PanelKey[] = ["explorer", "search", "git"]

function withSidebar(panels: Record<PanelKey, boolean>, key: PanelKey, open: boolean) {
  const next = { ...panels, [key]: open }
  if (open && SIDEBAR.includes(key)) {
    for (const other of SIDEBAR) if (other !== key) next[other] = false
  }
  return { panels: next }
}

function basename(p: string): string {
  const parts = p.split("/")
  return parts[parts.length - 1] || p
}

// nextActive picks the tab to focus after closing one. Falling back to the
// neighbour on the left is what every editor does, and it keeps the eye near
// where it already was.
// replacedByOpening decides whether opening a file should take the tab the
// person was looking at with it.
//
// Clicking through a tree to find something leaves a row of tabs nobody asked
// for. So a file tab that was only looked at — never edited — is replaced by
// the next one rather than kept. Editing it is what makes it worth keeping,
// which is the same rule the close button already uses to decide whether to
// warn.
//
// Only a file gives way to a file. A graph, the providers page and the store
// are somewhere the person navigated to on purpose, and closing one because
// they glanced at a file afterwards would lose real work.
function replacedByOpening(s: WorkspaceState, tab: Tab, openingID: string): boolean {
  return (
    tab.kind === "file" &&
    tab.id === s.activeTabId &&
    tab.id !== openingID &&
    !(tab.id in s.drafts)
  )
}

function nextActive(tabs: Tab[], closedIndex: number): string {
  if (tabs.length === 0) return ""
  const index = Math.min(closedIndex, tabs.length - 1)
  return tabs[index].id
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  project: null,
  root: null,
  opening: false,
  openError: "",

  tabs: [WELCOME],
  activeTabId: WELCOME.id,
  drafts: {},
  closedFiles: [],

  panels: { explorer: true, search: false, terminal: true, agent: true, git: false },
  mode: savedMode(),

  // Opening a project clears the editor area rather than leaving Welcome in it.
  // Welcome exists to answer "there is no project"; once there is one it is a
  // page about nothing, sitting where the first file should go, and it has to
  // be closed by hand before the window looks like an editor.
  setProject: (project) =>
    set(
      project
        ? { project, root: project.project, openError: "", opening: false, tabs: [], activeTabId: "", drafts: {}, closedFiles: [] }
        : { project: null, tabs: [WELCOME], activeTabId: WELCOME.id, drafts: {}, closedFiles: [] }
    ),
  setRoot: (root) => set({ root }),
  setOpening: (opening) => set({ opening }),
  setOpenError: (openError) => set({ openError, opening: false }),

  openFile: (path) => {
    const id = `file:${path}`
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = { kind: "file", id, path, title: basename(path) }
    set((s) => ({
      tabs: [...s.tabs.filter((t) => t.kind !== "welcome" && !replacedByOpening(s, t, id)), tab],
      activeTabId: id,
    }))
  },

  openGraph: (workflowId, title) => {
    const id = `graph:${workflowId}`
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = { kind: "graph", id, workflowId, title }
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
  },

  openDiff: (path, staged) => {
    const id = `diff:${staged ? "staged" : "working"}:${path}`
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = {
      kind: "diff",
      id,
      path,
      staged,
      title: `${basename(path)} (${staged ? "staged" : "working tree"})`,
    }
    set((s) => ({
      tabs: [...s.tabs.filter((t) => t.kind !== "welcome" && !replacedByOpening(s, t, id)), tab],
      activeTabId: id,
    }))
  },

  openGitOutput: () => {
    const id = "git-output"
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = { kind: "gitOutput", id, title: "Git Output" }
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
  },

  openProviders: () => {
    const id = "providers"
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = { kind: "providers", id, title: "Providers" }
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
  },

  openStore: () => {
    const id = "store"
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = { kind: "store", id, title: "Store" }
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
  },

  // Une vue de navigateur de plus, ou celle qui est déjà là.
  //
  // `reuse` est ce que demande un agent qui veut simplement une page ouverte :
  // il ne veut pas une vue de plus à chaque appel. Le bouton de la barre
  // latérale, lui, en ouvre une nouvelle à chaque clic — c'est ce qu'on lui
  // demande en cliquant dessus.
  openBrowser: (request = {}) => {
    const existing = get().tabs.find((t) => t.kind === "browser")
    if (request.reuse && existing) {
      set({ activeTabId: existing.id })
      return existing.id
    }
    const id = `browser:${nextBrowserId++}`
    const tab: Tab = { kind: "browser", id, title: "Browser", url: request.url ?? "", icon: "" }
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
    return id
  },

  // Le titre de la page devient celui de l'onglet, et la liste de la barre
  // latérale le lit : « Browser », « Browser », « Browser » ne dit pas laquelle
  // est la page de connexion.
  setBrowserPage: (id, url, title, icon) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id && t.kind === "browser"
          ? { ...t, url, title: title.trim() || "Browser", icon: icon ?? t.icon }
          : t
      ),
    })),

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      if (index < 0) return s
      const tabs = s.tabs.filter((t) => t.id !== id)
      const drafts = { ...s.drafts }
      delete drafts[id]
      // Retenu pour ⌘⇧T. Seulement les fichiers : un graphe ou une page se
      // rouvrent d'où on les a pris, un fichier fermé par mégarde non. Vingt,
      // parce qu'au-delà personne ne compte plus ses fermetures.
      const fermé = s.tabs[index]
      const closedFiles =
        fermé.kind === "file"
          ? [...s.closedFiles.filter((p) => p !== fermé.path), fermé.path].slice(-20)
          : s.closedFiles
      // Closing the last tab leaves the area empty when there is a project to
      // be empty about; without one, Welcome is the only thing to show.
      if (tabs.length === 0) {
        return s.project
          ? { tabs: [], activeTabId: "", drafts, closedFiles }
          : { tabs: [WELCOME], activeTabId: WELCOME.id, drafts, closedFiles }
      }
      return { tabs, drafts, closedFiles, activeTabId: s.activeTabId === id ? nextActive(tabs, index) : s.activeTabId }
    }),

  reopenClosed: () => {
    const { closedFiles, tabs } = get()
    // Le plus récent qui n'est pas déjà rouvert.
    const ouverts = new Set(tabs.map((t) => t.id))
    const restants = [...closedFiles]
    while (restants.length > 0) {
      const path = restants.pop() as string
      if (ouverts.has(`file:${path}`)) continue
      set({ closedFiles: restants })
      get().openFile(path)
      return
    }
    set({ closedFiles: [] })
  },

  activateTab: (activeTabId) => set({ activeTabId }),

  renameTab: (id, title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  // Les onglets suivent ce qu'on déplace ou renomme.
  //
  // Sans ça, l'onglet garde l'ancien chemin : il affiche encore le texte, et
  // la sauvegarde suivante recrée le fichier là où il n'est plus — un doublon
  // silencieux, à côté du vrai. Le brouillon suit aussi, sinon un fichier
  // modifié puis renommé perdrait ce qu'on n'avait pas enregistré.
  movePath: (from, to) =>
    set((s) => {
      const renamed = new Map<string, string>()
      const tabs = s.tabs.map((t) => {
        if (t.kind !== "file") return t
        const path = retarget(t.path, from, to)
        if (path === null) return t
        const id = `file:${path}`
        renamed.set(t.id, id)
        return { ...t, id, path, title: basename(path) }
      })
      if (renamed.size === 0) return s
      const drafts: Record<string, string> = {}
      for (const [id, text] of Object.entries(s.drafts)) drafts[renamed.get(id) ?? id] = text
      return { tabs, drafts, activeTabId: renamed.get(s.activeTabId) ?? s.activeTabId }
    }),

  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),
  clearDraft: (id) =>
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[id]
      return { drafts }
    }),

  // Opening one sidebar view closes the other. Terminal and agent are not part
  // of that bargain: they live elsewhere on screen and have no reason to
  // compete for the same column.
  togglePanel: (key) => set((s) => withSidebar(s.panels, key, !s.panels[key])),
  setPanel: (key, open) => set((s) => withSidebar(s.panels, key, open)),

  setMode: (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      // Not being able to remember the choice is not a reason to refuse it.
    }
    set({ mode })
  },
}))

// openRoute is the landing point for the Next.js router shim. The shared
// components only ever push a handful of paths, and outside the builder route
// none of them mean anything in a local project.
export function openRoute(href: string): void {
  const path = href.split("?")[0]
  const builder = /^\/builder\/([^/]+)$/.exec(path)
  if (builder) {
    const id = builder[1]
    const state = useWorkspace.getState()
    const known = state.tabs.find((t) => t.kind === "graph" && t.workflowId === id)
    state.openGraph(id, known?.title || "Workflow")
    return
  }
  if (path === "/providers" || path === "/settings") {
    useWorkspace.getState().openProviders()
  }
}
