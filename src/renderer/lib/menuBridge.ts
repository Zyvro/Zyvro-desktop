import { useWorkspace } from "~/state/workspace"
import { closeProject, createProject, createWorkflow, forgetRecents, openProject } from "./project"
import { askName } from "~/state/prompt"
import { askSearchFocus } from "~/state/reveal"
import { engineStopped } from "~/state/engine"
import { saveTab } from "~/state/savers"
import { requestCloseTab, saveAll } from "./closing"

// Menu commands arrive from the main process as IPC events, which is a
// subscription — and the project bans useEffect for exactly this. Registering
// them once at import time is simpler than any hook: there is one menu and one
// window, so there is nothing to tear down until the window itself goes away.
//
// The handlers here only touch the store. Anything that needs React context
// reads the resulting state.

type Command = "open-project" | "new-workflow" | "save" | "toggle-terminal" | "toggle-agent" | "find"

const listeners = new Map<Command, Set<() => void>>()

function fire(command: Command): void {
  for (const listener of listeners.get(command) ?? []) listener()
}

// onCommand lets a component react to a menu item it is the right owner of,
// such as Save, which only the focused editor can carry out.
export function onCommand(command: Command, handler: () => void): () => void {
  let set = listeners.get(command)
  if (!set) {
    set = new Set()
    listeners.set(command, set)
  }
  set.add(handler)
  return () => set?.delete(handler)
}

window.zyvro.menu.onOpenProject(() => {
  void openProject(null)
})
window.zyvro.menu.onNewProject(() => {
  void createProject()
})
window.zyvro.menu.onNewWorkflow(() => {
  if (!useWorkspace.getState().project) return
  void askName({
    title: "New workflow",
    label: "It is saved in this project under .zyvro/workflows.",
    initial: "Untitled workflow",
  }).then((name) => {
    if (name) void createWorkflow(name)
  })
})
// Save vise l'onglet actif, et lui seul : chaque éditeur s'inscrit auprès du
// registre, et c'est le registre qui choisit. Voir `state/savers`.
window.zyvro.menu.onSave(() => {
  void saveTab(useWorkspace.getState().activeTabId)
})
window.zyvro.menu.onSaveAll(() => {
  void saveAll()
})
window.zyvro.menu.onCloseTab(() => {
  const active = useWorkspace.getState().activeTabId
  if (active) void requestCloseTab(active)
})
window.zyvro.menu.onReopenTab(() => {
  useWorkspace.getState().reopenClosed()
})
window.zyvro.menu.onOpenPath((dir) => {
  void openProject(dir)
})
window.zyvro.menu.onCloseProject(() => {
  void closeProject()
})
window.zyvro.menu.onForgetRecents(() => {
  void forgetRecents()
})
window.zyvro.menu.onToggleSidebar(() => {
  useWorkspace.getState().togglePanel("explorer")
})
window.zyvro.menu.onToggleTerminal(() => {
  useWorkspace.getState().togglePanel("terminal")
})
window.zyvro.menu.onToggleAgent(() => {
  useWorkspace.getState().togglePanel("agent")
})

// ⌘F appartient à l'éditeur ouvert : c'est lui qui a une barre de recherche, et
// lui seul sait où est le curseur. Le menu ne fait que le lui dire.
window.zyvro.menu.onFindInFile(() => {
  fire("find")
})

// ⇧⌘F appartient au projet : le panneau s'ouvre et la frappe suivante atterrit
// dans son champ, sans qu'on ait à viser.
window.zyvro.menu.onFindInProject(() => {
  useWorkspace.getState().setPanel("search", true)
  askSearchFocus()
})

// Le moteur local est mort sans prévenir. Rien à faire depuis ici — c'est le
// processus principal qui le relancerait — mais il y a quelque chose à cesser
// de dire : la barre d'état annonce son port, et ce port ne répond plus.
window.zyvro.engine.onStopped((reason) => {
  engineStopped(reason)
})

// Un agent a demandé une page. Ce n'est pas un élément de menu, mais c'est la
// même mécanique — un événement du processus principal qui touche le magasin —
// et l'onglet doit exister avant que la vue puisse s'annoncer.
window.zyvro.browser.onOpen((payload) => {
  const state = useWorkspace.getState()
  const wanted = payload?.view ?? ""
  // Une vue nommée qui existe encore : on la révèle, on n'en fabrique pas une
  // autre. C'est ce qui fait qu'un agent peut dire « browser:2 » et voir la
  // personne regarder la même page que lui.
  if (wanted && wanted !== "new" && state.tabs.some((t) => t.id === wanted)) {
    state.activateTab(wanted)
    return
  }
  state.openBrowser({ reuse: wanted !== "new" })
})
