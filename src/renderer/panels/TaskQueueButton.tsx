import { useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  addTask,
  moveTask,
  removeTask,
  runTaskNow,
  setQueuePaused,
  updateTask,
  useTasks,
} from "~/state/tasks"
import { describeNext, REPEAT_LABELS, REPEATS, type Repeat, type ScheduledTask } from "../../shared/tasks"
import { RAIL_BUTTON } from "./railButton"

// La file de tâches du projet, dans la barre de l'agent.
//
// Ce qui doit partir à l'agent plus tard, ou après le reste : « relis les PR
// ouvertes » chaque matin à 9 h, trois refactorisations l'une après l'autre.
// Une tâche ne part que quand l'agent est libre, une à la fois, dans l'ordre
// de la liste ; chacune tourne dans sa propre conversation, qu'on ouvre pour
// suivre ou arrêter comme une autre.

export function TaskQueueButton(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const project = useTasks((s) => s.project)
  const file = useTasks((s) => s.file)
  const running = useTasks((s) => s.running)
  const now = useTasks((s) => s.now)
  if (!project) return null
  const waiting = file.tasks.filter((t) => t.runNow || t.enabled).length
  const due = file.tasks.some((t) => t.runNow || (t.enabled && (t.at === null || t.at <= now)))
  const title = running
    ? "Task queue — a task is running"
    : waiting === 0
      ? "Task queue — schedule prompts for the agent"
      : `Task queue — ${waiting} task${waiting > 1 ? "s" : ""} waiting${file.paused ? " (paused)" : due ? ", next as soon as the agent is free" : ""}`
  return (
    <>
      <button
        type="button"
        aria-label="Task queue"
        title={title}
        onClick={() => setOpen(true)}
        className={cn(RAIL_BUTTON, running ? "text-sky-300" : waiting > 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
      >
        <CalendarClock className="h-3.5 w-3.5" />
        {running ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" aria-hidden />
        ) : waiting > 0 ? (
          <span className={cn("absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full", file.paused ? "bg-muted-foreground" : "bg-primary")} aria-hidden />
        ) : null}
      </button>
      {open && <TaskQueueDialog onClose={() => setOpen(false)} />}
    </>
  )
}

type Draft = { id: string | null; title: string; prompt: string; when: "free" | "at"; at: string; repeat: Repeat }

function draftOf(task: ScheduledTask | null): Draft {
  if (!task) {
    const soon = new Date(Date.now() + 60 * 60_000)
    soon.setMinutes(0, 0, 0)
    return { id: null, title: "", prompt: "", when: "free", at: toLocalInput(soon.getTime()), repeat: "none" }
  }
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    when: task.at === null ? "free" : "at",
    at: toLocalInput(task.at ?? Date.now()),
    repeat: task.repeat,
  }
}

function TaskQueueDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const file = useTasks((s) => s.file)
  const running = useTasks((s) => s.running)
  const now = useTasks((s) => s.now)
  const [draft, setDraft] = useState<Draft | null>(null)

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="panel fixed left-1/2 top-[12%] z-50 flex max-h-[80vh] w-[600px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col p-5">
          <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="h-4 w-4" />
            Task queue
            <button
              type="button"
              onClick={() => setQueuePaused(!file.paused)}
              className={cn(
                "ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] font-normal",
                file.paused ? "bg-amber-400/15 text-amber-300 hover:bg-amber-400/25" : "text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              )}
              title={file.paused ? "Resume the queue" : "Pause the queue: nothing starts, nothing is lost"}
            >
              {file.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
              {file.paused ? "Paused — resume" : "Pause"}
            </button>
            <Dialog.Close className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground" aria-label="Close">
              <X className="h-3.5 w-3.5" />
            </Dialog.Close>
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Tasks start one at a time, in this order, when the agent is free — a task that falls due during a turn waits for
            it to end. Each runs in its own conversation, with the current permissions.
          </Dialog.Description>

          <div className="zy-scroll mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {file.tasks.length === 0 && !draft && (
              <p className="rounded-md border border-dashed border-white/[0.1] px-3 py-6 text-center text-[12px] text-muted-foreground">
                No tasks yet. Add one to run later, every day, or after the current work.
              </p>
            )}
            {file.tasks.map((task, index) =>
              draft?.id === task.id ? (
                <TaskForm key={task.id} draft={draft} onChange={setDraft} onDone={() => setDraft(null)} />
              ) : (
                <TaskRow
                  key={task.id}
                  task={task}
                  index={index}
                  last={index === file.tasks.length - 1}
                  running={running?.taskId === task.id}
                  label={describeNext(task, now, file.paused)}
                  onEdit={() => setDraft(draftOf(task))}
                />
              )
            )}
            {draft?.id === null && <TaskForm draft={draft} onChange={setDraft} onDone={() => setDraft(null)} />}
          </div>

          {!draft && (
            <button
              type="button"
              onClick={() => setDraft(draftOf(null))}
              className="mt-3 flex items-center gap-1.5 self-start rounded-md bg-white/[0.08] px-2.5 py-1.5 text-[12px] text-foreground hover:bg-white/[0.12]"
            >
              <Plus className="h-3.5 w-3.5" />
              New task
            </button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TaskRow({
  task,
  index,
  last,
  running,
  label,
  onEdit,
}: {
  task: ScheduledTask
  index: number
  last: boolean
  running: boolean
  label: string
  onEdit: () => void
}): JSX.Element {
  const icon = "rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-30"
  const off = !task.enabled && !task.runNow
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md border px-2 py-1.5",
        running ? "border-sky-400/30 bg-sky-400/[0.06]" : "border-white/[0.06] bg-white/[0.03]"
      )}
    >
      <span className="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground/70">
        {running ? <Loader2 className="h-3 w-3 zy-spin text-sky-300" /> : index + 1}
      </span>
      <div className={cn("min-w-0 flex-1", off && "opacity-50")}>
        <div className="truncate text-[12px] text-foreground" title={task.prompt}>
          {task.title}
        </div>
        <div className="truncate text-[10.5px] text-muted-foreground">
          {running ? "Running now" : label}
          {task.repeat !== "none" && ` · ${REPEAT_LABELS[task.repeat]}`}
          {task.lastStatus && !running && (
            <span className={cn(task.lastStatus === "failed" ? "text-destructive" : task.lastStatus === "stopped" ? "text-amber-300" : "")}>
              {` · last run ${task.lastStatus}`}
            </span>
          )}
        </div>
      </div>
      <button type="button" className={icon} title="Run now — next, as soon as the agent is free" disabled={running || task.runNow} onClick={() => runTaskNow(task.id)}>
        <Play className="h-3 w-3" />
      </button>
      <button type="button" className={icon} title="Move up" disabled={index === 0} onClick={() => moveTask(task.id, -1)}>
        <ChevronUp className="h-3 w-3" />
      </button>
      <button type="button" className={icon} title="Move down" disabled={last} onClick={() => moveTask(task.id, 1)}>
        <ChevronDown className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={cn(icon, task.enabled && "text-emerald-300")}
        title={task.enabled ? "On — click to turn off" : "Off — click to turn on"}
        onClick={() => updateTask(task.id, { enabled: !task.enabled, ...(!task.enabled && task.at !== null && task.at < Date.now() && task.repeat === "none" ? { at: null } : {}) })}
      >
        <Power className="h-3 w-3" />
      </button>
      <button type="button" className={icon} title="Edit" disabled={running} onClick={onEdit}>
        <Pencil className="h-3 w-3" />
      </button>
      <button type="button" className={cn(icon, "hover:text-destructive")} title="Delete" disabled={running} onClick={() => removeTask(task.id)}>
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  )
}

function TaskForm({ draft, onChange, onDone }: { draft: Draft; onChange: (d: Draft) => void; onDone: () => void }): JSX.Element {
  const at = fromLocalInput(draft.at)
  const valid = draft.prompt.trim() !== "" && (draft.when === "free" || at !== null)
  const submit = () => {
    if (!valid) return
    const fields = {
      title: draft.title,
      prompt: draft.prompt,
      at: draft.when === "free" ? null : at,
      repeat: draft.when === "free" ? ("none" as const) : draft.repeat,
    }
    if (draft.id) updateTask(draft.id, { ...fields, enabled: true })
    else addTask(fields)
    onDone()
  }
  const input = "w-full rounded-md border border-white/[0.08] bg-black/20 px-2 py-1.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-white/[0.16]"
  return (
    <div className="space-y-2 rounded-md border border-white/[0.1] bg-white/[0.03] p-2.5">
      <input
        value={draft.title}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
        placeholder="Title (optional)"
        className={input}
      />
      <textarea
        value={draft.prompt}
        autoFocus
        onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit()
        }}
        placeholder="What the agent should do — exactly as you would type it in the chat"
        rows={4}
        className={cn(input, "resize-y font-normal leading-relaxed")}
      />
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input type="radio" checked={draft.when === "free"} onChange={() => onChange({ ...draft, when: "free" })} />
          As soon as the agent is free
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input type="radio" checked={draft.when === "at"} onChange={() => onChange({ ...draft, when: "at" })} />
          At
        </label>
        <input
          type="datetime-local"
          value={draft.at}
          disabled={draft.when !== "at"}
          onChange={(e) => onChange({ ...draft, at: e.target.value, when: "at" })}
          className={cn(input, "w-auto py-1 [color-scheme:dark] disabled:opacity-40")}
        />
        <select
          value={draft.repeat}
          disabled={draft.when !== "at"}
          onChange={(e) => onChange({ ...draft, repeat: e.target.value as Repeat })}
          className={cn(input, "w-auto py-1 disabled:opacity-40")}
        >
          {REPEATS.map((r) => (
            <option key={r} value={r}>
              {REPEAT_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-md px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground">
          Cancel
        </button>
        <button
          type="button"
          disabled={!valid}
          onClick={submit}
          className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {draft.id ? "Save" : "Add to queue"}
        </button>
      </div>
    </div>
  )
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** `2026-10-06T09:00`, lu à l'heure locale — c'est ce que le champ affiche. */
function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}
