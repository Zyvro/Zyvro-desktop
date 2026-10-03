import { useState } from "react"
import { Thumb } from "~/panels/Thumb"
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
import { ToolOutput } from "~/lib/chatColors"

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
  /** Ce que l'outil a montré : une capture, un rendu. Des identifiants, jamais
   *  des octets — la vignette se demande au processus principal. */
  images: { id: string; name: string }[]
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

// Une couleur par sorte de travail, comme Claude Code et Codex en donnent une :
// on repère d'un coup d'œil où il a écrit, où il a lancé une commande.
// Les couleurs elles-mêmes sont celles du thème du chat, en variables.
const TINTS: Record<ToolShape, string> = {
  read: "text-[color:var(--zy-tool-read)]",
  edit: "text-[color:var(--zy-tool-edit)]",
  terminal: "text-[color:var(--zy-tool-terminal)]",
  search: "text-[color:var(--zy-tool-search)]",
  web: "text-[color:var(--zy-tool-web)]",
  plan: "text-[color:var(--zy-tool-plan)]",
  agent: "text-[color:var(--zy-tool-agent)]",
  zyvro: "text-primary",
  other: "text-muted-foreground",
}

// Le premier mot est le verbe — « Ran », « Edited », « Reading » — et le reste
// est ce sur quoi il porte, qui est ce qu'on cherche des yeux.
function splitVerb(label: string): [string, string] {
  const space = label.indexOf(" ")
  return space === -1 ? [label, ""] : [label.slice(0, space), label.slice(space)]
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

export function ToolRow({ call, conversationId }: { call: ToolCall; conversationId: string }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[call.shape] ?? Wrench
  // Present tense while it runs, past once it has — the distinction VS Code
  // makes with invocationMessage and pastTenseMessage, and it is worth making:
  // "Running the tests" and "Ran the tests" are different news.
  const label = call.finished ? call.done : call.running
  const [verb, subject] = splitVerb(label)
  const tint = call.isError ? "text-red-300" : TINTS[call.shape] ?? TINTS.other

  // A plan has nothing to fold: it is the thing you want to see.
  const body = call.shape === "plan" ? "plan" : call.detail || call.output ? "text" : "none"

  // Une image que l'agent vient de produire ne se replie pas non plus : c'est la
  // chose qu'on voulait voir, comme un plan. La replier reviendrait à annoncer
  // « j'ai pris une capture » et à la garder pour soi.
  const shown = call.images ?? []

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
        {/* Le point d'état, à la Claude Code : il pulse tant que l'outil
            tourne, vert quand il a fini, rouge quand il a échoué. */}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            !call.finished ? "zy-pulse bg-amber-300" : call.isError ? "bg-red-400" : "bg-emerald-400"
          )}
          aria-hidden
        />
        {call.finished ? (
          <Icon className={cn("h-3 w-3 shrink-0", tint)} />
        ) : (
          <Loader2 className={cn("h-3 w-3 shrink-0 zy-spin", tint)} />
        )}
        <span className="truncate">
          <span className={cn("font-medium", tint)}>{verb}</span>
          <span className={call.isError ? "text-red-300/80" : "text-foreground/80"}>{subject}</span>
        </span>
      </button>

      {call.shape === "plan" && call.plan.length > 0 && (
        <div className="ml-[18px] border-l border-white/[0.08] pl-2 pt-0.5 text-foreground/80">
          <Plan items={call.plan} />
        </div>
      )}

      {shown.length > 0 && (
        <div className="ml-[18px] mt-1 flex flex-wrap gap-1.5 border-l border-white/[0.08] pl-2">
          {shown.map((image) => (
            <Thumb
              key={image.id}
              conversationId={conversationId}
              image={image}
              size="h-24 w-24"
              // Une image LUE par un outil a un original dans le projet : c'est
              // lui que « Show in folder » montre.
              source={call.shape === "read" && call.detail ? call.detail : undefined}
            />
          ))}
        </div>
      )}

      {open && body === "text" && (
        <div className="ml-[18px] space-y-1 border-l border-white/[0.08] pl-2 pt-1">
          {call.detail && (
            <pre className="zy-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-foreground/75">
              {/* Une commande se lit comme dans un terminal : l'invite en vert. */}
              {call.shape === "terminal" ? <span className="select-none text-[color:var(--zy-tool-terminal)]">$ </span> : null}
              {call.detail}
            </pre>
          )}
          {call.output && (
            <ToolOutput
              text={call.output}
              className={cn(
                "zy-scroll max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed",
                call.isError ? "text-red-300/85" : "text-muted-foreground"
              )}
            />
          )}
        </div>
      )}
    </div>
  )
}
