import { useSyncExternalStore, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound } from "lucide-react"
import { cn } from "@/lib/utils"
import { getSettings, resetSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { useWorkspace } from "~/state/workspace"
import { DEFAULT_SETTINGS } from "../../shared/settings"
import { AgentChatSection, ConfigFileSection } from "~/panels/SettingsChat"
import type { CaptureSettings, CaptureSettingsView } from "../../preload"

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

// Un raccourci se tape en entier avant d'être essayé : à chaque touche, on
// enregistrerait « Command+S », puis « Command+Sh »… auprès du système.
function Raccourci({ valeur, erreur, onChange }: { valeur: string; erreur: string | null; onChange: (v: string) => void }) {
  const commit = (v: string) => {
    if (v.trim() && v.trim() !== valeur) onChange(v.trim())
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <input
        key={valeur}
        className={cn(champ, "w-64 font-mono text-[12px]", erreur && "border-red-400/60")}
        defaultValue={valeur}
        spellCheck={false}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value)
        }}
      />
      {erreur && <span className="max-w-64 text-right text-[11px] text-red-300">{erreur}</span>}
    </div>
  )
}

// Les réglages de l'icône de capture. Ils vivent dans le processus principal,
// pas dans le stockage de la fenêtre : l'icône existe sans fenêtre ouverte.
function CaptureSection() {
  const client = useQueryClient()
  const query = useQuery({ queryKey: ["capture-settings"], queryFn: () => window.zyvro.capture.settings() })
  const save = useMutation({
    mutationFn: (patch: Partial<CaptureSettings>) => window.zyvro.capture.update(patch),
    onSuccess: (next) => client.setQueryData(["capture-settings"], next),
  })
  const choose = useMutation({
    mutationFn: () => window.zyvro.capture.chooseFolder(),
    onSuccess: (next) => client.setQueryData(["capture-settings"], next),
  })
  const c: CaptureSettingsView | undefined = query.data
  if (!c) return null
  const mac = window.zyvro.platform === "darwin"
  return (
    <>
      <h2 className="mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Screen capture</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        The Zyvro icon in the {mac ? "menu bar" : "notification area"} captures an area of the screen, or records up to
        a minute of it, and can publish it as a public link that lasts 24 hours.
      </p>
      {/* Lancer une capture d'ici, et dire où est l'icône : sous Windows 11,
          une icône nouvelle est rangée derrière « ^ », et la capture avait
          l'air de ne pas exister. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
        <span
          className={cn("h-2 w-2 shrink-0 rounded-full", c.trayActive ? "bg-emerald-400" : "bg-red-400")}
          aria-hidden
        />
        <span className="min-w-0 flex-1 text-[12px] text-muted-foreground">
          {c.trayActive
            ? mac
              ? "The capture icon is in the menu bar."
              : "The capture icon is in the notification area. On Windows 11 it starts hidden: click ^ next to the clock, then drag the Zyvro icon onto the taskbar to keep it in view."
            : "The capture icon could not be created on this system — use the buttons here or the shortcuts below."}
        </span>
        <button
          type="button"
          onClick={() => void window.zyvro.capture.start("image")}
          className="rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[12px] hover:bg-white/[0.08]"
        >
          Capture area
        </button>
        <button
          type="button"
          onClick={() => void window.zyvro.capture.start("video")}
          className="rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[12px] hover:bg-white/[0.08]"
        >
          Record area
        </button>
      </div>
      <Ligne titre="Capture area" aide="Shortcut that works from any application.">
        <Raccourci valeur={c.shortcutImage} erreur={c.shortcutErrors.image} onChange={(shortcutImage) => save.mutate({ shortcutImage })} />
      </Ligne>
      <Ligne titre="Record area" aide="Press it again to stop. Recordings stop on their own after one minute.">
        <Raccourci valeur={c.shortcutVideo} erreur={c.shortcutErrors.video} onChange={(shortcutVideo) => save.mutate({ shortcutVideo })} />
      </Ligne>
      <Ligne
        titre="Keep a copy of every capture"
        aide={c.keepDir ? c.keepDir : "Every screenshot and recording is also saved in a folder you choose."}
      >
        <div className="flex items-center gap-3">
          {c.keepDir && (
            <button className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => choose.mutate()}>
              Change…
            </button>
          )}
          <Case
            valeur={c.keepDir !== null}
            onChange={(on) => (on ? choose.mutate() : save.mutate({ keepDir: null }))}
          />
        </div>
      </Ligne>
      {c.loginAvailable && (
        <Ligne titre="Start at login" aide="Open Zyvro Studio in the background when you log in, so the capture icon is always there.">
          <Case valeur={c.launchAtLogin} onChange={(launchAtLogin) => save.mutate({ launchAtLogin, loginAsked: true })} />
        </Ligne>
      )}
    </>
  )
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

        <AgentChatSection />

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

        <CaptureSection />

        <ConfigFileSection />
      </div>
    </div>
  )
}
