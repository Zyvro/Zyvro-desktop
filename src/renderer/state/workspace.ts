import { create } from "zustand"
import type { OpenResult } from "../../preload"

// The workspace is the window's whole model: which project is open, what is in
// the editor tabs, and which panels are showing. It lives in a store rather
// than in component state because the shims need to reach it from outside the
// React tree, when a shared component calls router.push.

export type Tab =
  | { kind: "welcome"; id: "welcome"; title: string }
  | { kind: "file"; id: string; path: string; title: string }
  | { kind: "graph"; id: string; workflowId: string; title: string }
  | { kind: "providers"; id: "providers"; title: string }

export type PanelKey = "explorer" | "terminal" | "agent"

type WorkspaceState = {
  project: OpenResult | null
  opening: boolean
  openError: string

  tabs: Tab[]
  activeTabId: string
  // Unsaved editor text keyed by tab id. A file tab reads its saved contents
  // through react-query and overlays whatever is here, so "dirty" is simply
  // "this key exists and differs from what was loaded".
  drafts: Record<string, string>

  panels: Record<PanelKey, boolean>

  setProject: (project: OpenResult | null) => void
  setOpening: (opening: boolean) => void
  setOpenError: (message: string) => void

  openFile: (path: string) => void
  openGraph: (workflowId: string, title: string) => void
  openProviders: () => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  renameTab: (id: string, title: string) => void

  setDraft: (id: string, text: string) => void
  clearDraft: (id: string) => void

  togglePanel: (key: PanelKey) => void
  setPanel: (key: PanelKey, open: boolean) => void
}

const WELCOME: Tab = { kind: "welcome", id: "welcome", title: "Welcome" }

function basename(p: string): string {
  const parts = p.split("/")
  return parts[parts.length - 1] || p
}

// nextActive picks the tab to focus after closing one. Falling back to the
// neighbour on the left is what every editor does, and it keeps the eye near
// where it already was.
function nextActive(tabs: Tab[], closedIndex: number): string {
  if (tabs.length === 0) return WELCOME.id
  const index = Math.min(closedIndex, tabs.length - 1)
  return tabs[index].id
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  project: null,
  opening: false,
  openError: "",

  tabs: [WELCOME],
  activeTabId: WELCOME.id,
  drafts: {},

  panels: { explorer: true, terminal: true, agent: true },

  setProject: (project) =>
    set(
      project
        ? { project, openError: "", opening: false }
        : { project: null, tabs: [WELCOME], activeTabId: WELCOME.id, drafts: {} }
    ),
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
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
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

  openProviders: () => {
    const id = "providers"
    if (get().tabs.some((t) => t.id === id)) {
      set({ activeTabId: id })
      return
    }
    const tab: Tab = { kind: "providers", id, title: "Providers" }
    set((s) => ({ tabs: [...s.tabs.filter((t) => t.kind !== "welcome"), tab], activeTabId: id }))
  },

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      if (index < 0) return s
      const tabs = s.tabs.filter((t) => t.id !== id)
      const drafts = { ...s.drafts }
      delete drafts[id]
      if (tabs.length === 0) return { tabs: [WELCOME], activeTabId: WELCOME.id, drafts }
      return { tabs, drafts, activeTabId: s.activeTabId === id ? nextActive(tabs, index) : s.activeTabId }
    }),

  activateTab: (activeTabId) => set({ activeTabId }),

  renameTab: (id, title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  setDraft: (id, text) => set((s) => ({ drafts: { ...s.drafts, [id]: text } })),
  clearDraft: (id) =>
    set((s) => {
      const drafts = { ...s.drafts }
      delete drafts[id]
      return { drafts }
    }),

  togglePanel: (key) => set((s) => ({ panels: { ...s.panels, [key]: !s.panels[key] } })),
  setPanel: (key, open) => set((s) => ({ panels: { ...s.panels, [key]: open } })),
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
