import { useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Users,
  Wrench,
  Zap,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { PlanItem, ToolShape } from "../../preload"

// One line per thing the agent did, with the detail a click away.
//
// The panel used to say "ran Edit" — the tool's name, and nothing about what it
// touched. Somebody watching it write code learned that code had been written.
//
// The shape here is the one VS Code and Cursor both arrived at, read out of
// their shipped code: a past-tense sentence that names its subject ("Edited
// math.js", not "ran Edit"), an icon for the kind of work, and the body folded
// away. Folded by default because most rows are not the one you are looking
// for, and a transcript that unrolled every file it read would bury the answer.

export type ToolCall = {
  callId: string
  running: string
  done: string
  shape: ToolShape
  detail: string
  plan: PlanItem[]
  output: string
  isError: boolean
  finished: boolean
}

const ICONS: Record<ToolShape, typeof Wrench> = {
  read: FileText,
  edit: Pencil,
  terminal: Terminal,
  search: Search,
  web: Globe,
  plan: ListChecks,
  agent: Users,
  zyvro: Zap,
  other: Wrench,
}

// A plan reads as a checklist, which is the one input worth showing as itself
// rather than as text.
function Plan({ items }: { items: PlanItem[] }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="flex items-start gap-1.5">
          <span
            className={cn(
              "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
              item.status === "completed"
                ? "bg-emerald-400"
                : item.status === "in_progress"
                  ? "bg-amber-400"
                  : "bg-white/20"
            )}
          />
          <span className={cn("leading-snug", item.status === "completed" && "text-muted-foreground line-through")}>
            {item.title}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.shape] ?? Wrench
  // Present tense while it runs, past once it has — the distinction VS Code
  // makes with invocationMessage and pastTenseMessage, and it is worth making:
  // "Running the tests" and "Ran the tests" are different news.
  const label = call.finished ? call.done : call.running

  // A plan has nothing to fold: it is the thing you want to see.
  const body = call.shape === "plan" ? "plan" : call.detail || call.output ? "text" : "none"

  return (
    <div className="text-[11px]">
      <button
        type="button"
        disabled={body === "none"}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left",
          body === "none" ? "cursor-default" : "hover:bg-white/[0.06]",
          call.isError ? "text-red-300" : "text-muted-foreground"
        )}
      >
        {body === "none" ? (
          <span className="w-3" />
        ) : open ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
        )}
        {call.finished ? (
          <Icon className="h-3 w-3 shrink-0" />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 zy-spin" />
        )}
        <span className="truncate">{label}</span>
      </button>

      {call.shape === "plan" && call.plan.length > 0 && (
        <div className="ml-[18px] border-l border-white/[0.08] pl-2 pt-0.5 text-foreground/80">
          <Plan items={call.plan} />
        </div>
      )}

      {open && body === "text" && (
        <div className="ml-[18px] space-y-1 border-l border-white/[0.08] pl-2 pt-1">
          {call.detail && (
            <pre className="zy-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-foreground/75">
              {call.detail}
            </pre>
          )}
          {call.output && (
            <pre
              className={cn(
                "zy-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed",
                call.isError ? "text-red-300/85" : "text-muted-foreground"
              )}
            >
              {call.output}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
