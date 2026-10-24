import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import * as Dialog from "@radix-ui/react-dialog"
import { Brain, FileText, FolderOpen, Loader2, Save, Sparkles, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { queryClient } from "~/lib/queryClient"
import { useWorkspace } from "~/state/workspace"
import { MEMORY_FILE, type MemoryInfo, type MemoryState } from "../../shared/memory"
import type { Permission } from "../../shared/permission"
import { RAIL_BUTTON } from "./railButton"

// La mémoire du projet, dans la barre de l'agent.
//
// Un cerveau qui dit l'état d'un coup d'œil : creux quand il n'y a rien, un
// point vert quand elle est à jour, ambre quand le dépôt a bougé depuis. Un
// clic montre le fichier, le laisse corriger, et propose de lancer un agent
// qui explore le dépôt pour l'écrire ou la remettre à jour — dans une
// conversation à lui, qu'on regarde et qu'on peut arrêter comme une autre.

export const memoryKey = (project: string) => ["project-memory", project] as const

/** Après un tour d'agent : la mémoire a peut-être été réécrite. */
export function refreshMemory(): void {
  void queryClient.invalidateQueries({ queryKey: ["project-memory"] })
}

const STATE_LABEL: Record<MemoryState, string> = {
  empty: "No memory yet",
  fresh: "Up to date",
  stale: "Probably out of date",
}

export function MemoryButton({
  project,
  permission,
  onRunAgent,
}: {
  project: string
  permission: Permission
  /** Lance l'agent qui écrit la mémoire, dans une nouvelle conversation. */
  onRunAgent: (exists: boolean, file: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const memory = useQuery({
    queryKey: memoryKey(project),
    queryFn: () => window.zyvro.project.memory(project),
    // Écrite par un agent, ou à la main dans l'éditeur : relue de temps en
    // temps plutôt que surveillée.
    refetchInterval: 60_000,
    retry: false,
  })
  const info = memory.data
  const state = info?.state ?? "empty"
  const file = info?.file ?? MEMORY_FILE
  return (
    <>
      <button
        type="button"
        aria-label="Project memory"
        data-memory-state={state}
        title={`Project memory (${file}): ${STATE_LABEL[state]}${info?.commitsSince ? ` — ${info.commitsSince} commit${info.commitsSince > 1 ? "s" : ""} since it was written` : ""}`}
        onClick={() => {
          setOpen(true)
          void memory.refetch()
        }}
        className={cn(
          RAIL_BUTTON,
          state === "empty" ? "text-muted-foreground/60 hover:text-foreground" : state === "stale" ? "text-amber-300" : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Brain className="h-3.5 w-3.5" />
        {state !== "empty" && (
          <span className={cn("absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full", state === "stale" ? "bg-amber-300" : "bg-emerald-400")} aria-hidden />
        )}
      </button>
      {open && (
        <Dialog.Root open onOpenChange={(o) => !o && setOpen(false)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
            <Dialog.Content className="panel fixed left-1/2 top-[12%] z-50 flex max-h-[80vh] w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col p-5">
              <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
                <Brain className="h-4 w-4" />
                Project memory
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    state === "empty" ? "bg-white/[0.06] text-muted-foreground" : state === "stale" ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"
                  )}
                >
                  {STATE_LABEL[state]}
                </span>
                <Dialog.Close className="ml-auto rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground" aria-label="Close">
                  <X className="h-3.5 w-3.5" />
                </Dialog.Close>
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                <span className="font-mono text-foreground/80">{file}</span> in this project. Every new agent session receives it
                at startup, whatever the harness — so it starts knowing the layout, the commands and the gotchas.
              </Dialog.Description>
              {!info ? (
                <div className="flex items-center gap-2 py-8 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 zy-spin" /> Reading {file}…
                </div>
              ) : (
                <>
                <MemoryFilePicker project={project} info={info} />
                <MemoryEditor
                  key={`${info.file}:${info.updatedAt ?? "none"}`}
                  project={project}
                  info={info}
                  permission={permission}
                  onRunAgent={() => {
                    setOpen(false)
                    onRunAgent(info.state !== "empty", info.file)
                  }}
                />
                </>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  )
}

// Quel fichier sert de mémoire : ZYVRO.md par défaut, ou un fichier que le
// projet tient déjà (CLAUDE.md, AGENTS.md…), ou n'importe lequel du projet.
function MemoryFilePicker({ project, info }: { project: string; info: MemoryInfo }): JSX.Element {
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const apply = async (run: () => Promise<MemoryInfo | null>) => {
    setBusy(true)
    setError("")
    try {
      const next = await run()
      if (next) queryClient.setQueryData(memoryKey(project), next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  // Le fichier actuel d'abord, puis ceux que le projet a déjà, puis ZYVRO.md.
  const options = [...new Set([info.file, ...info.candidates, MEMORY_FILE])]
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px]">
      <span className="text-muted-foreground">File</span>
      <select
        aria-label="Memory file"
        value={info.file}
        disabled={busy}
        onChange={(e) => void apply(() => window.zyvro.project.setMemoryFile(project, e.target.value === MEMORY_FILE ? null : e.target.value))}
        className="rounded-md border border-white/[0.08] bg-black/20 px-1.5 py-1 font-mono text-[11.5px] text-foreground outline-none"
      >
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
            {info.candidates.includes(name) ? "" : " (not created yet)"}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy}
        onClick={() => void apply(() => window.zyvro.project.pickMemoryFile(project))}
        className="flex items-center gap-1 rounded-md bg-white/[0.06] px-2 py-1 text-foreground hover:bg-white/[0.1] disabled:opacity-40"
        title="Use any file of this project as its memory"
      >
        <FolderOpen className="h-3 w-3" />
        Choose a file…
      </button>
      {error && <span className="basis-full text-destructive">{error}</span>}
    </div>
  )
}

function MemoryEditor({
  project,
  info,
  permission,
  onRunAgent,
}: {
  project: string
  info: MemoryInfo
  permission: Permission
  onRunAgent: () => void
}): JSX.Element {
  const [text, setText] = useState(info.text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const dirty = text !== info.text
  const exists = info.state !== "empty"

  const save = async () => {
    setSaving(true)
    setError("")
    try {
      const next = await window.zyvro.project.saveMemory(project, text)
      queryClient.setQueryData(memoryKey(project), next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {info.updatedAt === null
          ? "Not written yet. Let an agent explore the repository and write it, or start it by hand below."
          : `Written ${ago(info.updatedAt)}${info.commitsSince === null ? "" : ` · ${info.commitsSince} commit${info.commitsSince === 1 ? "" : "s"} since`}.`}
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder={"# Project memory\n\nWhat this project is, how to build and test it, where things live, what breaks silently…"}
        className="zy-scroll mt-2 min-h-[16rem] w-full flex-1 resize-none rounded-md border border-white/[0.08] bg-black/20 p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-white/[0.16]"
      />
      {permission === "read" && (
        <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200">
          The agent is in Read only: it can explore, but not write {info.file}. Switch permissions to Workspace first.
        </p>
      )}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onRunAgent}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px]",
            info.state === "fresh" ? "bg-white/[0.06] text-foreground hover:bg-white/[0.1]" : "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
          title="Opens a new agent conversation that explores the repository and writes the file"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {exists ? "Update with an agent" : "Create with an agent"}
        </button>
        {exists && (
          <button
            type="button"
            onClick={() => useWorkspace.getState().openFile(info.path)}
            className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/[0.1]"
          >
            <FileText className="h-3.5 w-3.5" />
            Open in editor
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/[0.12] disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 zy-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>
    </>
  )
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}
