import { useState, useSyncExternalStore } from "react"
import { Check, Copy, Download, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { AGENT_KINDS, HARNESSES, harnessEnabled, isChatKind, type AgentKind } from "../../shared/harness"
import { getSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { installHarness, useHarnessesInstalled } from "~/lib/harnessInstall"
import { HarnessMark } from "./HarnessPicker"

// Les harnais du marché, allumés ou éteints — Providers › Harnesses.
//
// Demandé : « ajoute tous les harness qui existent sur le marché, sous forme de
// plugin providers, avec un espace dédié pour les enable / disable ; par défaut
// claude, codex et qwen activés ». Un harnais allumé apparaît dans le menu
// « agent » du Shell et dans le lanceur ; éteint, il n'encombre rien. Les
// sessions déjà ouvertes avec lui restent ouvertes.

export function HarnessesSection(): JSX.Element {
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const installed = useHarnessesInstalled()
  const [filtre, setFiltre] = useState("")
  const [copie, setCopie] = useState<AgentKind | null>(null)

  const toggle = (kind: AgentKind, on: boolean): void => {
    const agent = getSettings().agent
    updateSettings({ agent: { ...agent, harnesses: { ...agent.harnesses, [kind]: on } } })
  }
  const q = filtre.trim().toLowerCase()
  const list = AGENT_KINDS.filter((kind) => {
    const h = HARNESSES[kind]
    return !q || h.name.toLowerCase().includes(q) || h.vendor.toLowerCase().includes(q) || h.bin.includes(q)
  })
  const allumes = AGENT_KINDS.filter((kind) => harnessEnabled(settings.agent, kind)).length

  return (
    <section className="mt-8" data-harnesses>
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <h2 className="text-base font-semibold">Harnesses</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            The coding agents you can open in the Shell. {allumes} enabled — enabled ones appear in the agent menu and the
            launcher. Each runs with its own account and settings.
          </p>
        </div>
        <label className="flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.02] px-2 py-1">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            value={filtre}
            onChange={(e) => setFiltre(e.target.value)}
            placeholder="Filter"
            className="w-32 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/70"
          />
        </label>
      </div>

      <div className="panel mt-3 divide-y divide-white/[0.06]">
        {list.map((kind) => {
          const h = HARNESSES[kind]
          const on = harnessEnabled(settings.agent, kind)
          const present = installed.data?.harnesses[kind]
          const npm = installed.data?.npm ?? true
          const canInstall = Boolean(h.npmPackage ? npm : h.installer || (h.launch && window.zyvro.platform !== "win32"))
          return (
            <div key={kind} className="flex items-center gap-3 px-3 py-2.5" data-harness={kind}>
              <HarnessMark kind={kind} className="h-7 w-7" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-foreground">{h.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{h.vendor}</span>
                  {!isChatKind(kind) && (
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground" title="Opens in the Shell; the chat panel does not drive it.">
                      Shell
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <code className="rounded bg-white/[0.05] px-1">{h.bin}</code>
                  {present === undefined ? null : present ? (
                    <span className="text-emerald-300/90">installed</span>
                  ) : (
                    <span className="text-amber-300/90">not installed</span>
                  )}
                </div>
              </div>
              {present === false &&
                (canInstall ? (
                  <button
                    type="button"
                    onClick={() => installHarness(kind)}
                    className="flex items-center gap-1 rounded-md bg-white/[0.06] px-2 py-1 text-[12px] text-foreground hover:bg-white/[0.1]"
                    title={h.install}
                  >
                    <Download className="h-3 w-3" /> Install
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(h.install)
                      setCopie(kind)
                    }}
                    className="flex items-center gap-1 rounded-md bg-white/[0.06] px-2 py-1 text-[12px] text-foreground hover:bg-white/[0.1]"
                    title={h.install}
                  >
                    {copie === kind ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Install command
                  </button>
                ))}
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${on ? "Disable" : "Enable"} ${h.name}`}
                onClick={() => toggle(kind, !on)}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                  on ? "bg-primary" : "bg-white/[0.12]"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
                    on ? "left-[18px]" : "left-0.5"
                  )}
                />
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
