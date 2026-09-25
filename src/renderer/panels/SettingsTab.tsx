import { useSyncExternalStore, type ReactNode } from "react"
import { KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import { getSettings, resetSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { useWorkspace } from "~/state/workspace"
import { DEFAULT_SETTINGS } from "../../shared/settings"

// Les réglages de l'éditeur (⌘,). Chaque changement s'applique tout de suite
// aux éditeurs ouverts ; il n'y a pas de bouton « Appliquer », comme dans VS
// Code.

function Ligne({ titre, aide, children }: { titre: string; aide: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-white/[0.06] py-4">
      <div>
        <p className="text-[13px] font-medium text-foreground">{titre}</p>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{aide}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const champ =
  "h-8 rounded-md border border-white/10 bg-white/[0.03] px-2 text-[13px] outline-none focus:border-primary/50"

function Choix<T extends string>({
  valeur,
  options,
  onChange,
}: {
  valeur: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <select className={cn(champ, "pr-6")} value={valeur} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Nombre({ valeur, min, max, onChange }: { valeur: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <input
      type="number"
      className={cn(champ, "w-20")}
      value={valeur}
      min={min}
      max={max}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n) && e.target.value !== "") onChange(n)
      }}
    />
  )
}

function Case({ valeur, onChange }: { valeur: boolean; onChange: (b: boolean) => void }) {
  return <input type="checkbox" className="h-4 w-4 accent-sky-400" checked={valeur} onChange={(e) => onChange(e.target.checked)} />
}

export function SettingsTab() {
  const r = useSyncExternalStore(subscribeSettings, getSettings, getSettings)
  const openProviders = useWorkspace((s) => s.openProviders)
  return (
    <div className="zy-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">Settings</h1>
          <button className="text-[12px] text-muted-foreground hover:text-foreground" onClick={resetSettings}>
            Reset to defaults
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Kept on this computer and applied to open editors as you change them.
        </p>

        <button
          className="panel mt-6 flex w-full items-center gap-3 p-4 text-left hover:bg-white/[0.03]"
          onClick={openProviders}
        >
          <KeyRound className="h-4 w-4 shrink-0 text-violet-300" />
          <span className="text-[13px]">
            <span className="font-medium text-foreground">Providers and API keys</span>
            <span className="text-muted-foreground"> — the models your workflows and the agent run on</span>
          </span>
        </button>

        <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Editor</h2>
        <Ligne titre="Font size" aide={`In pixels. Default ${DEFAULT_SETTINGS.fontSize}.`}>
          <Nombre valeur={r.fontSize} min={8} max={32} onChange={(fontSize) => updateSettings({ fontSize })} />
        </Ligne>
        <Ligne titre="Tab size" aide="The width of an indentation step.">
          <Nombre valeur={r.tabSize} min={1} max={8} onChange={(tabSize) => updateSettings({ tabSize })} />
        </Ligne>
        <Ligne titre="Insert spaces" aide="Pressing Tab inserts spaces rather than a tab character.">
          <Case valeur={r.insertSpaces} onChange={(insertSpaces) => updateSettings({ insertSpaces })} />
        </Ligne>
        <Ligne
          titre="Detect indentation"
          aide="Follow the indentation a file already uses. The two settings above then apply only to new files."
        >
          <Case valeur={r.detectIndentation} onChange={(detectIndentation) => updateSettings({ detectIndentation })} />
        </Ligne>
        <Ligne titre="Word wrap" aide="Wrap long lines at the edge of the editor.">
          <Choix
            valeur={r.wordWrap}
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            onChange={(wordWrap) => updateSettings({ wordWrap })}
          />
        </Ligne>
        <Ligne titre="Minimap" aide="A thumbnail of the whole file at the right of the editor.">
          <Case valeur={r.minimap} onChange={(minimap) => updateSettings({ minimap })} />
        </Ligne>
        <Ligne titre="Bracket pair colorization" aide="Matching brackets share a color, one per nesting level.">
          <Case
            valeur={r.bracketPairColorization}
            onChange={(bracketPairColorization) => updateSettings({ bracketPairColorization })}
          />
        </Ligne>
        <Ligne titre="Sticky scroll" aide="The lines that open the blocks you are scrolling through stay at the top.">
          <Case valeur={r.stickyScroll} onChange={(stickyScroll) => updateSettings({ stickyScroll })} />
        </Ligne>
        <Ligne titre="Line numbers" aide="Relative numbers count from the cursor's line.">
          <Choix
            valeur={r.lineNumbers}
            options={[
              { value: "on", label: "On" },
              { value: "relative", label: "Relative" },
              { value: "off", label: "Off" },
            ]}
            onChange={(lineNumbers) => updateSettings({ lineNumbers })}
          />
        </Ligne>
        <Ligne titre="Render whitespace" aide="Show spaces and tabs as faint dots and arrows.">
          <Choix
            valeur={r.renderWhitespace}
            options={[
              { value: "none", label: "None" },
              { value: "selection", label: "In the selection" },
              { value: "boundary", label: "Leading and trailing" },
              { value: "all", label: "All" },
            ]}
            onChange={(renderWhitespace) => updateSettings({ renderWhitespace })}
          />
        </Ligne>

        <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Files</h2>
        <Ligne titre="Auto save" aide="Write changes to disk without pressing ⌘S.">
          <Choix
            valeur={r.autoSave}
            options={[
              { value: "off", label: "Off" },
              { value: "afterDelay", label: "After a delay" },
              { value: "onFocusChange", label: "When the editor loses focus" },
            ]}
            onChange={(autoSave) => updateSettings({ autoSave })}
          />
        </Ligne>
        {r.autoSave === "afterDelay" && (
          <Ligne titre="Auto save delay" aide="Milliseconds after the last keystroke.">
            <Nombre valeur={r.autoSaveDelay} min={200} max={60000} onChange={(autoSaveDelay) => updateSettings({ autoSaveDelay })} />
          </Ligne>
        )}

        <Ligne titre="Format on save" aide="Format the file when you save it (⌘S), with the built-in formatter for TypeScript, JavaScript, JSON, CSS and HTML. Auto save never formats.">
          <Case valeur={r.formatOnSave} onChange={(formatOnSave) => updateSettings({ formatOnSave })} />
        </Ligne>

        <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Application</h2>
        <Ligne titre="Check for updates" aide="Ask GitHub for a newer release at startup and every few hours. Nothing is downloaded without asking.">
          <Case valeur={r.checkForUpdates} onChange={(checkForUpdates) => updateSettings({ checkForUpdates })} />
        </Ligne>
      </div>
    </div>
  )
}
