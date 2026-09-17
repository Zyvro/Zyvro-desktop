import { useSyncExternalStore } from "react"
import { Camera, Download, Link as LinkIcon } from "lucide-react"
import { CTA_PRIMARY, CTA_SECONDARY } from "@/components/ui/cta"
import { cn } from "@/lib/utils"

// Photographier une zone de l'application, au clic.
//
// On capture surtout pour montrer : un bout d'interface dans un message, une
// issue, une démo. L'outil de la machine capture un écran ou une fenêtre
// entière, donc il faut recadrer ensuite, et le recadrage à la main ne tombe
// jamais juste sur le bord d'un panneau.
//
// Ici l'application sait où sont ses panneaux : elle les propose, on en vise
// un, elle le rend au pixel près. Puis elle demande quoi en faire : garder sur
// la machine, ou partager un lien. Les deux gestes n'ont pas les mêmes
// conséquences — l'un reste ici, l'autre publie — donc la question se pose au
// lieu d'être tranchée à notre place.

// ZONES est l'inventaire, et il vit à côté de l'attribut qu'il cherche : un
// panneau qui perd son `data-shot-zone` disparaît simplement du choix, sans
// casser quoi que ce soit.
export const ZONE_ATTR = "data-shot-zone"

export type Zone = { name: string; rect: { x: number; y: number; width: number; height: number } }

// findZones lit la position réelle des panneaux à l'instant du clic. Les
// mesurer d'avance donnerait des cadres faux dès qu'on déplace un séparateur.
export function findZones(root: ParentNode = document): Zone[] {
  const seen = new Set<string>()
  const zones: Zone[] = []
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${ZONE_ATTR}]`))) {
    const name = el.getAttribute(ZONE_ATTR) ?? ""
    const box = el.getBoundingClientRect()
    // Un panneau replié mesure zéro : le proposer donnerait une image vide.
    if (!name || seen.has(name) || box.width < 24 || box.height < 24) continue
    seen.add(name)
    zones.push({
      name,
      rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    })
  }
  // Du plus petit au plus grand : deux zones qui se chevauchent — un panneau
  // dans une colonne — doivent laisser la plus précise se viser en premier.
  return zones.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
}

// zoneAt répond à la question « qu'est-ce que je vise » : la plus petite zone
// sous le curseur, puisque c'est la plus précise.
export function zoneAt(zones: Zone[], x: number, y: number): Zone | null {
  for (const z of zones) {
    const r = z.rect
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return z
  }
  return null
}

// ---- l'état, hors de React ---------------------------------------------
//
// Un mode qui se termine sur une touche, un clic n'importe où, ou un
// changement de fenêtre, se décrit mieux comme un abonnement que comme un
// effet : il n'appartient à aucun composant en particulier.

type Picking = { zones: Zone[]; hover: Zone | null } | null

// Ce qui vient d'être photographié et attend une décision. Garder et partager
// ne sont pas la même chose — l'un reste sur la machine, l'autre publie — donc
// la question se pose au lieu d'être tranchée à notre place.
type Taken = { zone: string; preview: string; bytes: number; busy: "" | "save" | "share"; error: string } | null

let picking: Picking = null
let taken: Taken = null
let toast: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => picking
const takenSnapshot = () => taken
const toastSnapshot = () => toast
const nothing = () => null

function stop() {
  picking = null
  window.removeEventListener("keydown", onKey, true)
  window.removeEventListener("mousemove", onMove, true)
  window.removeEventListener("mousedown", onClick, true)
  emit()
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault()
    stop()
  }
}

function onMove(e: MouseEvent) {
  if (!picking) return
  const hover = zoneAt(picking.zones, e.clientX, e.clientY)
  if (hover?.name !== picking.hover?.name) {
    picking = { ...picking, hover }
    emit()
  }
}

function onClick(e: MouseEvent) {
  if (!picking) return
  e.preventDefault()
  e.stopPropagation()
  const zone = zoneAt(picking.zones, e.clientX, e.clientY)
  stop()
  if (zone) void capture(zone)
}

async function capture(zone: Zone) {
  try {
    const shot = await window.zyvro.shots.capture(zone.rect, zone.name)
    taken = { zone: zone.name, preview: shot.preview, bytes: shot.bytes, busy: "", error: "" }
    emit()
  } catch (err) {
    say(err instanceof Error ? err.message : "Could not capture")
  }
}

export function dismissShot(): void {
  taken = null
  emit()
}

async function decide(what: "save" | "share") {
  if (!taken) return
  taken = { ...taken, busy: what, error: "" }
  emit()
  try {
    if (what === "save") {
      const file = await window.zyvro.shots.save()
      taken = null
      emit()
      // Le nom du fichier, pas son chemin entier : il est dans les
      // téléchargements, et l'image vient de s'ouvrir de toute façon.
      say(`Saved ${file.split("/").pop()}`)
    } else {
      const url = await window.zyvro.shots.share()
      await navigator.clipboard.writeText(url).catch(() => {})
      taken = null
      emit()
      say("Link copied")
    }
  } catch (err) {
    // L'erreur reste dans la fenêtre plutôt que de la fermer : l'image est
    // toujours là, et la plus fréquente — « connecte-toi pour publier » — se
    // répare en deux clics sans avoir à reprendre la capture.
    taken = taken ? { ...taken, busy: "", error: err instanceof Error ? err.message : "Could not do that" } : null
    emit()
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function say(message: string) {
  toast = message
  emit()
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast = null
    emit()
  }, 2600)
}

export function startPicking() {
  const zones = findZones()
  if (zones.length === 0) return
  picking = { zones, hover: null }
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("mousemove", onMove, true)
  window.addEventListener("mousedown", onClick, true)
  emit()
}

// ---- les composants -----------------------------------------------------

export function ShotButton() {
  const active = useSyncExternalStore(subscribe, snapshot, nothing) !== null
  return (
    <button
      type="button"
      onClick={() => (active ? stop() : startPicking())}
      title="Screenshot a panel — click the button, then the panel you want. It lands in Downloads and opens. Esc cancels."
      className={cn(
        "flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
        active && "text-primary"
      )}
    >
      <Camera className="h-3 w-3" />
    </button>
  )
}

// ShotDialog : ce qu'on fait de la capture.
//
// L'image d'abord, en grand. Une fenêtre qui demande « garder ou partager »
// sans montrer ce qu'on a pris demande de se souvenir, et on vient justement
// de cliquer sur un panneau parmi six.
function ShotDialog() {
  const shot = useSyncExternalStore(subscribe, takenSnapshot, nothing)
  if (!shot) return null

  return (
    <div className="fixed inset-0 z-[102] flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm">
      <div className="w-[min(34rem,90vw)] overflow-hidden rounded-2xl border border-white/10 bg-card shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        <div className="max-h-[50vh] overflow-hidden border-b border-white/[0.06] bg-black/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shot.preview} alt={`Screenshot of ${shot.zone}`} className="block w-full object-contain" />
        </div>

        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{shot.zone}</span>
            <span className="text-[11px] text-muted-foreground">{Math.round(shot.bytes / 1024)} KB</span>
          </div>

          {shot.error && <p className="text-[12px] leading-relaxed text-red-300">{shot.error}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={shot.busy !== ""}
              onClick={() => void decide("save")}
              className={cn(CTA_SECONDARY, "h-10 flex-1 px-4 disabled:opacity-60")}
            >
              <Download className="h-4 w-4" />
              {shot.busy === "save" ? "Saving…" : "Download"}
            </button>
            <button
              type="button"
              disabled={shot.busy !== ""}
              onClick={() => void decide("share")}
              className={cn(CTA_PRIMARY, "h-10 flex-1 px-4 disabled:opacity-60")}
            >
              <LinkIcon className="h-4 w-4" />
              {shot.busy === "share" ? "Uploading…" : "Share a link"}
            </button>
            <button
              type="button"
              onClick={dismissShot}
              className="h-10 rounded-xl px-3 text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>

          {/* Dit avant le clic, pas après : « partager » met une image sur
              internet, et un lien public se re-partage tout seul. */}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Download keeps it on this machine. Share uploads it to your Zyvro account and copies a public link — anyone
            with the link can open it.
          </p>
        </div>
      </div>
    </div>
  )
}

export function ShotOverlay() {
  const state = useSyncExternalStore(subscribe, snapshot, nothing)
  const message = useSyncExternalStore(subscribe, toastSnapshot, nothing)

  return (
    <>
      <ShotDialog />
      {state && (
        <div className="fixed inset-0 z-[100] cursor-crosshair">
          {state.zones.map((z) => {
            const on = state.hover?.name === z.name
            return (
              <div
                key={z.name}
                className={cn(
                  "pointer-events-none absolute rounded-md border transition-colors",
                  on ? "border-primary bg-primary/10" : "border-white/20 bg-white/[0.02]"
                )}
                style={{ left: z.rect.x, top: z.rect.y, width: z.rect.width, height: z.rect.height }}
              >
                {/* Le nom seulement sur la zone visée : posé sur toutes, il
                    recouvrait l'en-tête de chaque panneau, et on ne voyait plus
                    ce qu'on était en train de choisir. */}
                {on && (
                  <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-primary-foreground shadow-lg">
                    {z.name}
                  </span>
                )}
              </div>
            )
          })}
          <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center">
            <span className="rounded-full bg-black/80 px-3 py-1.5 text-[11px] text-muted-foreground shadow-lg">
              Click a panel · Esc to cancel
            </span>
          </div>
        </div>
      )}

      {message && (
        <div className="pointer-events-none fixed bottom-9 left-1/2 z-[101] -translate-x-1/2">
          <span className="rounded-full bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground shadow-lg">
            {message}
          </span>
        </div>
      )}
    </>
  )
}
