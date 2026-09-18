import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { registerPluginKinds, type NodeKind } from "@/lib/nodes"
import type { OpenResult } from "../../preload"
import { attachDaemon, detachDaemon } from "./daemon"
import { queryClient } from "./queryClient"
import { useWorkspace } from "~/state/workspace"
import { engineStarted } from "~/state/engine"

// Opening a project is the operation that changes everything: it starts a
// daemon, points the shared API client at it, and gives the file tree a root.
// It lives here as a plain function, not only as a hook, because the File menu
// has to be able to trigger it from outside the React tree.

export const projectKey = ["project", "current"] as const
export const workflowsKey = ["local", "workflows"] as const
export const nodesKey = ["local", "nodes"] as const
export const recentsKey = ["project", "recents"] as const

function adopt(result: OpenResult | null): OpenResult | null {
  // Un projet qui s'ouvre, c'est un démon qui vient de répondre : l'annonce
  // d'une panne précédente n'a plus lieu d'être. Sans ça, la barre garderait le
  // souvenir d'un moteur mort réparé depuis.
  if (result) engineStarted()
  if (result) attachDaemon(result.daemon.origin, result.daemon.token)
  else detachDaemon()
  // Node packs belong to a project. Closing one has to take its nodes with it,
  // or the palette would go on offering a type the next project cannot run.
  if (!result) registerPluginKinds([])
  useWorkspace.getState().setProject(result)
  return result
}

// useNodeCatalogue asks the engine what it can run. The set is no longer fixed:
// a project can install packs of Lua nodes, and the palette has to show them.
// Registering happens in the fetcher rather than in a component, because the
// node registry is read during render by code that is not ours.
export function useNodeCatalogue() {
  const project = useWorkspace((s) => s.project)
  return useQuery({
    queryKey: nodesKey,
    queryFn: async () => {
      const response = await fetch("http://127.0.0.1:0/api/nodes")
      if (!response.ok) throw new Error(`The engine listed no nodes (${response.status}).`)
      const kinds = (await response.json()) as NodeKind[]
      // The catalogue carries the built-ins too. registerPluginKinds drops
      // anything that collides with one, so handing it the whole list is both
      // correct and tolerant of the engine adding a built-in we do not know.
      registerPluginKinds(Array.isArray(kinds) ? kinds : [])
      return kinds
    },
    enabled: Boolean(project),
    staleTime: 30_000,
  })
}

// openProject opens a folder, or asks for one when given null. It resolves to
// null when the user cancels the dialog, which is not an error.
export async function openProject(dir: string | null): Promise<OpenResult | null> {
  const store = useWorkspace.getState()
  try {
    const target = dir ?? (await window.zyvro.project.choose())
    if (!target) {
      store.setOpening(false)
      return null
    }
    store.setOpening(true)
    const result = await window.zyvro.project.open(target)
    adopt(result)
    queryClient.setQueryData(projectKey, result)
    // The previous project's workflows and file listings must not survive into
    // the new one, or the tree would describe a folder that is no longer open.
    queryClient.removeQueries({ queryKey: ["local"] })
    queryClient.removeQueries({ queryKey: ["files"] })
    void queryClient.invalidateQueries({ queryKey: recentsKey })
    return result
  } catch (err) {
    store.setOpenError((err as Error).message)
    return null
  }
}

// createProject makes a new folder and opens it. It is the same operation as
// opening, with one step in front, and it lives beside openProject for the same
// reason that one does: the File menu has to reach it from outside React.
//
// Failure to create is reported through the same channel as failure to open,
// because from where the person sits the two are one action that did not work.
export async function createProject(): Promise<OpenResult | null> {
  const store = useWorkspace.getState()
  let target: string | null
  try {
    target = await window.zyvro.project.create()
  } catch (err) {
    store.setOpenError((err as Error).message)
    return null
  }
  if (!target) return null
  return openProject(target)
}

// useRecents backs the list on the welcome screen. The File menu reads the
// same data from disk in the main process, so the two cannot disagree.
export function useRecents() {
  return useQuery({ queryKey: recentsKey, queryFn: () => window.zyvro.project.recents() })
}

export async function forgetRecents(): Promise<void> {
  const recents = await window.zyvro.project.forgetRecents()
  queryClient.setQueryData(recentsKey, recents)
}

export async function closeProject(): Promise<void> {
  await window.zyvro.project.close()
  adopt(null)
  queryClient.setQueryData(projectKey, null)
  queryClient.removeQueries({ queryKey: ["local"] })
  queryClient.removeQueries({ queryKey: ["files"] })
}

// createWorkflow is here rather than in the list panel for the same reason:
// the New Workflow menu item must reach it without a component being mounted.
export async function createWorkflow(name: string): Promise<void> {
  const workflow = await api.createWorkflow(name, { nodes: [], edges: [] })
  await queryClient.invalidateQueries({ queryKey: workflowsKey })
  useWorkspace.getState().openGraph(workflow.id, workflow.name)
}

// useCurrentProject asks the main process what this window already has open.
// The daemon outlives a renderer reload in development, so the answer is not
// always "nothing".
export function useCurrentProject() {
  return useQuery({
    queryKey: projectKey,
    queryFn: async () => adopt(await window.zyvro.project.current()),
    staleTime: Infinity,
  })
}

export function useOpenProject() {
  return useMutation({ mutationFn: (dir: string | null) => openProject(dir) })
}

export function useCreateProject() {
  return useMutation({ mutationFn: () => createProject() })
}
