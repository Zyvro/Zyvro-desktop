import { useState, useSyncExternalStore, type CSSProperties } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Download, FolderOpen, ImagePlus, RotateCcw, Trash2, Upload } from "lucide-react"
import { cn } from "@/lib/utils"
import { getSettings, replaceSettings, resetSettings, subscribeSettings, updateSettings } from "~/state/settings"
import { WorkingGlyph } from "~/lib/chatColors"
import {
  CHAT_THEMES,
  CUSTOM_ANIMATIONS,
  CUSTOM_INDICATOR_MAX,
  WORKING_INDICATORS,
  sanitizeCustomIndicator,
  type ChatTheme,
  type CustomAnimation,
} from "../../shared/chatThemes"

// Les réglages du chat d'agent : son thème, l'indicateur qui tourne pendant
// qu'il écrit — y compris une image à soi — et le fichier où tout cela est
// rangé, à exporter, importer ou retrouver dans le Finder.
//
// Chaque choix se montre au lieu de se nommer : une carte de thème est
// dessinée dans ses propres couleurs, une carte d'indicateur tourne.

const titre = "mt-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"

function useReglages() {
  return useSyncExternalStore(subscribeSettings, getSettings)
}

// ---------- le thème ----------

function ThemeCard({ theme, active, onPick }: { theme: ChatTheme; active: boolean; onPick: () => void }) {
  // Les variables du thème posées sur la carte elle-même : l'aperçu est peint
  // avec sa palette, quel que soit le thème choisi pour le reste du chat.
  const style = theme.vars as CSSProperties
  return (
    <button
      type="button"
      onClick={onPick}
      style={style}
      className={cn(
        "rounded-lg border bg-white/[0.02] p-3 text-left transition-colors hover:bg-white/[0.05]",
        active ? "border-primary ring-1 ring-primary/50" : "border-white/[0.08]"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">{theme.label}</span>
        <span className="flex gap-1" aria-hidden>
          {["--zy-tool-read", "--zy-tool-edit", "--zy-tool-terminal", "--zy-tool-search", "--zy-syn-keyword"].map((v) => (
            <span key={v} className="h-2.5 w-2.5 rounded-full" style={{ background: `var(${v})` }} />
          ))}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{theme.hint}</p>
      <div className="mt-2 space-y-0.5 rounded-md bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed">
        <div>
          <span className="text-[color:var(--zy-tool-read)]">Read</span> <span className="text-foreground/80">app.ts</span>
          <span className="ml-2 text-[color:var(--zy-tool-terminal)]">Ran</span> <span className="text-foreground/80">npm test</span>
        </div>
        <div>
          <span className="text-[color:var(--zy-syn-keyword)]">const</span>{" "}
          <span className="text-foreground">answer</span> <span className="text-[color:var(--zy-syn-delim)]">=</span>{" "}
          <span className="text-[color:var(--zy-syn-string)]">"ok"</span>{" "}
          <span className="text-[color:var(--zy-syn-comment)] italic">// done</span>
        </div>
        <div className="text-[color:var(--zy-diff-add)] bg-[color:var(--zy-diff-add-bg)]">+ added line</div>
        <div className="text-[color:var(--zy-diff-del)] bg-[color:var(--zy-diff-del-bg)]">- removed line</div>
      </div>
    </button>
  )
}

// ---------- l'indicateur ----------

const ACCEPTED = "image/png,image/gif,image/webp,image/svg+xml,image/jpeg"
// 500 Ko de fichier donnent ~680 Ko en base64 : sous le plafond que le
// nettoyage des réglages accepte.
const MAX_FILE = 500 * 1024

function lireImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read that file."))
    reader.readAsDataURL(file)
  })
}

function IndicatorSection() {
  const r = useReglages()
  const [erreur, setErreur] = useState("")

  const televerser = async (file: File | undefined) => {
    setErreur("")
    if (!file) return
    if (file.size > MAX_FILE) {
      setErreur(`That image is ${Math.round(file.size / 1024)} KB; keep it under 500 KB — it is shown at 14 pixels.`)
      return
    }
    try {
      const dataUrl = await lireImage(file)
      const custom = sanitizeCustomIndicator({ dataUrl, name: file.name, animation: r.customIndicator?.animation ?? "spin" })
      if (!custom || dataUrl.length > CUSTOM_INDICATOR_MAX) {
        setErreur("Use a PNG, GIF, WebP, SVG or JPEG image.")
        return
      }
      updateSettings({ customIndicator: custom, workingIndicator: "custom" })
    } catch (err) {
      setErreur((err as Error).message)
    }
  }

  return (
    <div className="mt-3">
      <p className="text-[13px] font-medium text-foreground">Working indicator</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        What turns at the end of a message while the agent is writing. A GIF of your own keeps its animation.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {WORKING_INDICATORS.map((w) => {
          const active = r.workingIndicator === w.id
          const disabled = w.id === "custom" && !r.customIndicator
          return (
            <button
              key={w.id}
              type="button"
              disabled={disabled}
              onClick={() => updateSettings({ workingIndicator: w.id })}
              title={disabled ? "Upload an image first" : `Use ${w.label}`}
              className={cn(
                "flex flex-col items-start gap-2 rounded-lg border bg-white/[0.02] p-3 text-left transition-colors hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40",
                active ? "border-primary ring-1 ring-primary/50" : "border-white/[0.08]"
              )}
            >
              <span className="flex h-5 items-center gap-1.5 text-[11px]">
                <WorkingGlyph variant={w.id} custom={r.customIndicator} tint="text-[color:var(--zy-working)]" />
                <span className="zy-shimmer font-medium">Writing</span>
              </span>
              <span className="text-[12px] text-foreground/85">{w.label}</span>
            </button>
          )
        })}
      </div>

      {/* Sa propre image : téléversée ici, gardée dans les réglages — donc dans
          le fichier exporté. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
        {r.customIndicator ? (
          <>
            <img src={r.customIndicator.dataUrl} alt="" className="h-8 w-8 rounded border border-white/[0.08] object-contain p-1" />
            <span className="min-w-0 max-w-[12rem] truncate text-[12px] text-foreground/85" title={r.customIndicator.name}>
              {r.customIndicator.name}
            </span>
            <select
              className="h-8 rounded-md border border-white/10 bg-white/[0.03] px-2 text-[12px] outline-none focus:border-primary/50"
              value={r.customIndicator.animation}
              onChange={(e) =>
                updateSettings({ customIndicator: { ...r.customIndicator!, animation: e.target.value as CustomAnimation } })
              }
              title="How your image moves"
            >
              {CUSTOM_ANIMATIONS.map((a) => (
                <option key={a} value={a}>
                  {a === "none" ? "No animation" : a[0].toUpperCase() + a.slice(1)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="text-[12px] text-muted-foreground">No image of your own yet.</span>
        )}
        <div className="flex-1" />
        <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[12px] hover:bg-white/[0.08]">
          <ImagePlus className="h-3.5 w-3.5" />
          {r.customIndicator ? "Replace…" : "Upload an image…"}
          <input
            type="file"
            accept={ACCEPTED}
            className="hidden"
            onChange={(e) => {
              void televerser(e.target.files?.[0])
              e.target.value = ""
            }}
          />
        </label>
        {r.customIndicator && (
          <button
            type="button"
            onClick={() =>
              updateSettings({
                customIndicator: null,
                workingIndicator: r.workingIndicator === "custom" ? "sparkle" : r.workingIndicator,
              })
            }
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </button>
        )}
      </div>
      {erreur && <p className="mt-1.5 text-[12px] text-red-300">{erreur}</p>}
    </div>
  )
}

export function AgentChatSection() {
  const r = useReglages()
  return (
    <>
      <h2 className={titre}>Agent chat</h2>
      <p className="mt-3 text-[13px] font-medium text-foreground">Theme</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        The colours of tools, code, diffs and text in the agent panel. Each harness keeps its own colour.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {CHAT_THEMES.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            active={r.chatTheme === theme.id}
            onPick={() => updateSettings({ chatTheme: theme.id })}
          />
        ))}
      </div>
      <IndicatorSection />
    </>
  )
}

// ---------- le fichier de configuration ----------

export function ConfigFileSection() {
  const [dit, setDit] = useState("")
  const fichier = useQuery({ queryKey: ["settings-file"], queryFn: () => window.zyvro.settingsFile.read() })
  const reveal = useMutation({ mutationFn: () => window.zyvro.settingsFile.reveal() })
  const exporter = useMutation({
    mutationFn: () => window.zyvro.settingsFile.exportTo(getSettings()),
    onSuccess: (path) => setDit(path ? `Exported to ${path}` : ""),
  })
  const importer = useMutation({
    mutationFn: () => window.zyvro.settingsFile.importFrom(),
    onSuccess: (lu) => {
      if (!lu) return
      replaceSettings(lu.settings)
      setDit(`Imported from ${lu.path}`)
    },
  })
  const echec = [reveal, exporter, importer].find((m) => m.isError)?.error as Error | undefined
  const bouton =
    "flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.04] px-2.5 py-1 text-[12px] hover:bg-white/[0.08] disabled:opacity-50"

  return (
    <>
      <h2 className={titre}>Configuration file</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        Editor, appearance and agent defaults are kept in this JSON file. Export it to back up these preferences.
        Permissions, prompt rewriting, usage display and capture settings are stored separately on this computer.
        Skill packs themselves are not included in the export.
      </p>
      <p className="zy-selectable mt-2 truncate rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-foreground/80" title={fichier.data?.path}>
        {fichier.data?.path ?? "…"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" className={bouton} onClick={() => reveal.mutate()} disabled={reveal.isPending}>
          <FolderOpen className="h-3.5 w-3.5" />
          Show in folder
        </button>
        <button type="button" className={bouton} onClick={() => exporter.mutate()} disabled={exporter.isPending}>
          <Download className="h-3.5 w-3.5" />
          Export…
        </button>
        <button type="button" className={bouton} onClick={() => importer.mutate()} disabled={importer.isPending}>
          <Upload className="h-3.5 w-3.5" />
          Import…
        </button>
        <button
          type="button"
          className={cn(bouton, "border-transparent bg-transparent text-muted-foreground hover:text-foreground")}
          onClick={() => {
            resetSettings()
            setDit("Editor, appearance and agent defaults have been reset.")
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset these preferences
        </button>
        {(echec || dit) && (
          <span className={cn("ml-1 truncate text-[11px]", echec ? "text-red-300" : "text-muted-foreground")}>
            {echec ? echec.message : dit}
          </span>
        )}
      </div>
    </>
  )
}
