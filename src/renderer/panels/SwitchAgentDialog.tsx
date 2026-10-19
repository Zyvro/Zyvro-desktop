import { useState, useSyncExternalStore } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { ArrowRight, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { EFFORTS, promptDelivery, recordTitle, supportsEffort, type AgentShellRecord, type Effort } from "../../shared/agentShell"
import type { AgentKind } from "../../shared/harness"
import { closeSwitch, getSwitch, subscribeSwitch } from "~/state/switchAgent"
import { recordOf } from "~/state/agentShells"
import { getSettings } from "~/state/settings"
import { useHarnessesInstalled } from "~/lib/harnessInstall"
import { HarnessPicker } from "./HarnessPicker"
import { ModelPicker } from "./ModelPicker"

// Changer d'agent sur une session : le même fil, avec un autre modèle ; ou le
// relais à un autre harnais.
//
// Ce qu'on ne peut pas faire à la main. Dans un harnais, le modèle d'une session
// se change rarement, et jamais d'un fournisseur à un autre (d'Opus à un modèle
// Ollama, par exemple). Et une session appartient à son harnais : l'identifiant de
// claude ne dit rien à codex.
//
//   · même harnais — « Continue this session » : la session est reprise telle quelle
//     (`--resume`), avec le nouveau modèle ;
//   · n'importe quel cas — « Hand over » : un agent neuf reçoit en premier message un
//     briefing tiré du transcript (shared/agentShell, `briefing`).

export type SwitchChoice = {
  record: AgentShellRecord
  kind: AgentKind
  model: string | null
  effort: Effort | null
  mode: "resume" | "handoff"
  stopCurrent: boolean
}

const field =
  "h-7 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 text-[12px] text-foreground outline-none hover:bg-white/[0.08]"

// Les harnais dont on sait lire le transcript pour en faire un briefing.
const READABLE: readonly AgentKind[] = ["claude", "codex"]

export function SwitchAgentDialog({
  isLive,
  onSwitch,
}: {
  /** L'agent de cette session tourne-t-il en ce moment ? */
  isLive: (recordId: string) => boolean
  onSwitch: (choice: SwitchChoice) => Promise<void>
}): JSX.Element | null {
  const request = useSyncExternalStore(subscribeSwitch, getSwitch, () => null)
  const record = request ? recordOf(request.record) : undefined
  if (!request || !record) return null
  // Une clé : la boîte repart de la configuration de CHAQUE session qu'on ouvre.
  return <Body key={record.id} record={record} live={isLive(record.id)} onSwitch={onSwitch} />
}

function Body({
  record,
  live,
  onSwitch,
}: {
  record: AgentShellRecord
  live: boolean
  onSwitch: (choice: SwitchChoice) => Promise<void>
}): JSX.Element {
  const installed = useHarnessesInstalled()
  const [kind, setKind] = useState<AgentKind>(record.kind)
  const [model, setModel] = useState<string | null>(record.model)
  const [effort, setEffort] = useState<Effort | null>(record.effort)
  const [mode, setMode] = useState<"resume" | "handoff">("resume")
  const [stopCurrent, setStopCurrent] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const same = kind === record.kind
  // Un autre harnais ne peut que prendre le relais ; le même peut aussi reprendre.
  const effective = same ? mode : "handoff"
  const unchanged = same && model === record.model && effort === record.effort
  const readable = READABLE.includes(record.kind) && record.sessionId !== null

  const go = async (): Promise<void> => {
    setBusy(true)
    setError("")
    try {
      await onSwitch({ record, kind, model, effort, mode: effective, stopCurrent })
      closeSwitch()
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
      setBusy(false)
    }
  }

  const radio = (value: "resume" | "handoff", title: string, hint: string, disabled = false) => (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border border-white/[0.08] p-2 text-[12px]",
        effective === value && "border-sky-400/40 bg-sky-400/[0.06]",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <input
        type="radio"
        name="switch-mode"
        className="mt-0.5 accent-sky-400"
        checked={effective === value}
        disabled={disabled}
        onChange={() => setMode(value)}
      />
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  )

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && closeSwitch()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="panel fixed left-1/2 top-[18%] z-50 w-[30rem] max-w-[92vw] -translate-x-1/2 p-4 outline-none">
          <Dialog.Title className="flex items-center justify-between text-[13px] font-semibold">
            Switch agent
            <Dialog.Close className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground" aria-label="Close">
              <X className="h-3.5 w-3.5" />
            </Dialog.Close>
          </Dialog.Title>
          <Dialog.Description className="mt-1 truncate text-[12px] text-muted-foreground">
            {recordTitle(record)} · {record.kind}
            {record.model ? ` · ${record.model}` : ""}
          </Dialog.Description>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <HarnessPicker
              className="h-7"
              kind={kind}
              installed={(k) => installed.data?.harnesses[k] ?? true}
              onChange={(next) => {
                setKind(next)
                setModel(next === record.kind ? record.model : (getSettings().agent.defaultModels[next] ?? null))
                setEffort(null)
              }}
            />
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 max-w-[14rem]">
              <ModelPicker framed className="h-7" kind={kind} model={model} ranWith={null} onChange={setModel} />
            </div>
            {supportsEffort(kind) && (
              <select
                aria-label="Reasoning effort"
                className={field}
                value={effort ?? ""}
                onChange={(e) => setEffort(e.target.value === "" ? null : (e.target.value as Effort))}
              >
                <option value="">effort: default</option>
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    effort: {e}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="mt-3 space-y-2">
            {radio(
              "resume",
              "Continue this session",
              same
                ? "The same conversation, resumed with the new model. A model from another provider (a local server, say) may not read a long history written by another one."
                : "Only within the same harness: a session belongs to the program that wrote it.",
              !same
            )}
            {radio(
              "handoff",
              "Hand over",
              readable
                ? `A new ${kind} session starts with a briefing built from this one's transcript (the last exchanges, shortened), then you carry on.`
                : `A new ${kind} session starts with a short briefing. ${record.kind} does not keep a transcript Zyvro can read, so it carries no history: the agent is told to check the repository and ask.`
            )}
          </div>

          {effective === "handoff" && promptDelivery(kind) === "paste" && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {kind} takes no task on its command line: the briefing is pasted into its prompt once it is ready — read it, then press Enter.
            </p>
          )}
          {effective === "handoff" && live && (
            <label className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
              <input type="checkbox" className="accent-sky-400" checked={stopCurrent} onChange={(e) => setStopCurrent(e.target.checked)} />
              Stop the current agent
            </label>
          )}
          {effective === "resume" && live && (
            <p className="mt-2 text-[11px] text-muted-foreground">The running agent is stopped and reopened on the same session.</p>
          )}
          {error && <p className="mt-2 text-[12px] text-red-400">{error}</p>}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={closeSwitch}
              disabled={busy}
              className="h-8 rounded-md border border-white/[0.1] px-3 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void go()}
              disabled={busy || (effective === "resume" && unchanged)}
              className="h-8 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
            >
              {effective === "resume" ? "Switch model" : "Hand over"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
