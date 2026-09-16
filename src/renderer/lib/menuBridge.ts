import { useWorkspace } from "~/state/workspace"
import { closeProject, createWorkflow, forgetRecents, openProject } from "./project"
import { askName } from "~/state/prompt"

// Menu commands arrive from the main process as IPC events, which is a
// subscription — and the project bans useEffect for exactly this. Registering
// them once at import time is simpler than any hook: there is one menu and one
// window, so there is nothing to tear down until the window itself goes away.
//
// The handlers here only touch the store. Anything that needs React context
// reads the resulting state.

type Command = "open-project" | "new-workflow" | "save" | "toggle-terminal" | "toggle-agent"

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
window.zyvro.menu.onSave(() => fire("save"))
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
