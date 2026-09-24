// Où en est la mise à jour de l'application.
//
// Un magasin de module : la barre d'état, la boîte de dialogue et le menu en
// parlent, et aucun n'est le parent des autres.

import { getSettings } from "~/state/settings"

export type UpdateInfo = NonNullable<Awaited<ReturnType<typeof window.zyvro.update.check>>>

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "available"; info: UpdateInfo }
  | { phase: "downloading"; info: UpdateInfo; received: number; total: number }
  | { phase: "ready"; info: UpdateInfo; verified: boolean }
  | { phase: "error"; message: string; info?: UpdateInfo }

let etat: UpdateState = { phase: "idle" }
let ouvert = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}
function poser(e: UpdateState): void {
  etat = e
  emit()
}

export const updateState = (): UpdateState => etat
export const updateDialogOpen = (): boolean => ouvert
export function subscribeUpdate(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function setUpdateDialog(open: boolean): void {
  ouvert = open
  emit()
}

/**
 * Demander s'il y a une version plus récente. `quiet` : la vérification
 * automatique, qui ne dit rien quand il n'y a rien — ni quand le réseau
 * manque, ce qui n'est pas une nouvelle.
 */
export async function checkForUpdate(quiet: boolean): Promise<void> {
  // Un téléchargement en cours ou prêt n'est pas à recommencer.
  if (etat.phase === "downloading" || etat.phase === "ready") {
    if (!quiet) setUpdateDialog(true)
    return
  }
  if (!quiet) {
    poser({ phase: "checking" })
    setUpdateDialog(true)
  }
  try {
    const info = await window.zyvro.update.check()
    if (info) {
      poser({ phase: "available", info })
      return
    }
    if (!quiet) poser({ phase: "none" })
    else if (etat.phase === "checking") poser({ phase: "idle" })
  } catch (err) {
    if (!quiet) poser({ phase: "error", message: (err as Error).message })
  }
}

export async function downloadUpdate(): Promise<void> {
  if (etat.phase !== "available" && etat.phase !== "error") return
  const info = etat.info
  if (!info) return
  poser({ phase: "downloading", info, received: 0, total: info.asset?.size ?? 0 })
  const off = window.zyvro.update.onProgress(({ received, total }) => {
    if (etat.phase === "downloading") poser({ ...etat, received, total })
  })
  try {
    const r = await window.zyvro.update.download()
    poser({ phase: "ready", info, verified: r.verified })
  } catch (err) {
    poser({ phase: "error", message: (err as Error).message, info })
  } finally {
    off()
  }
}

export async function installUpdate(): Promise<"quitting" | "opened" | null> {
  try {
    return await window.zyvro.update.install()
  } catch (err) {
    poser({ phase: "error", message: (err as Error).message, info: "info" in etat ? etat.info : undefined })
    return null
  }
}

// La vérification automatique : peu après le démarrage — pas pendant, la
// fenêtre a mieux à faire — puis toutes les six heures, pour qui laisse
// l'application ouverte des jours. Coupée par le réglage.
const PREMIERE_MS = 15_000
const ENSUITE_MS = 6 * 60 * 60 * 1000
function auto(): void {
  if (getSettings().checkForUpdates) void checkForUpdate(true)
}
setTimeout(auto, PREMIERE_MS)
setInterval(auto, ENSUITE_MS)
window.zyvro.update.onCheckRequested(() => void checkForUpdate(false))
