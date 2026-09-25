import { useSyncExternalStore } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { ArrowUpCircle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  downloadUpdate,
  installUpdate,
  setUpdateDialog,
  subscribeUpdate,
  updateDialogOpen,
  updateState,
} from "~/state/update"

// La proposition de mise à jour : quelle version, ce qui a changé, et un bouton
// qui la télécharge puis l'installe. Rien ne se fait sans qu'on le demande.

const bouton = "rounded-lg px-3 py-1.5 text-[13px]"
const secondaire = cn(bouton, "border border-white/[0.1] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground")
const principal = cn(bouton, "bg-primary font-medium text-primary-foreground hover:bg-primary/90")

function mo(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function UpdateDialog() {
  const open = useSyncExternalStore(subscribeUpdate, updateDialogOpen, updateDialogOpen)
  const etat = useSyncExternalStore(subscribeUpdate, updateState, updateState)
  if (!open) return null
  const mac = window.zyvro.platform === "darwin"
  const info = "info" in etat ? etat.info : undefined
  // `manual` : l'application ne peut pas s'écrire là où elle est (voir
  // main/updater.ts), l'image disque s'ouvre. Sinon elle se met à jour seule.
  const seule = info?.kind !== "manual"

  return (
    <Dialog.Root open onOpenChange={(o) => !o && setUpdateDialog(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="panel fixed left-1/2 top-1/3 z-50 w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5">
          <Dialog.Title className="text-sm font-semibold">
            {etat.phase === "checking" && "Checking for updates…"}
            {etat.phase === "none" && "Zyvro Studio is up to date"}
            {etat.phase === "idle" && "Updates"}
            {info && etat.phase !== "error" && `Zyvro Studio ${info.latest} is available`}
            {etat.phase === "error" && "The update did not work"}
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-2 text-[12px] leading-relaxed text-muted-foreground">
              {etat.phase === "checking" && (
                <p className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 zy-spin" /> Asking GitHub for the latest release.
                </p>
              )}
              {etat.phase === "none" && <p>You have the latest version.</p>}
              {info && (
                <p>
                  You have {info.current}.{" "}
                  <button className="text-sky-300 hover:underline" onClick={() => void window.zyvro.openExternal(info.url)}>
                    See what&apos;s new
                  </button>
                </p>
              )}
              {info && !info.asset && <p>There is no installer for this computer in that release.</p>}
              {etat.phase === "downloading" && (
                <div>
                  <div className="h-1.5 overflow-hidden rounded bg-white/[0.08]">
                    <div
                      className="h-full bg-primary transition-[width]"
                      style={{ width: `${etat.total ? Math.min(100, (etat.received / etat.total) * 100) : 0}%` }}
                    />
                  </div>
                  <p className="mt-1">
                    {mo(etat.received)} of {mo(etat.total)}
                  </p>
                </div>
              )}
              {etat.phase === "ready" && (
                <p>
                  Downloaded
                  {etat.verified ? ", and its SHA-256 matches the one published with the release" : ""}.{" "}
                  {seule
                    ? `Zyvro Studio closes, installs ${info?.latest ?? "the update"} in place, and opens again. Unsaved files are asked about first.`
                    : "Zyvro Studio cannot replace itself where it is (a read-only folder, or it was opened straight from Downloads). The disk image opens next: drag Zyvro Studio onto the one in Applications, then reopen it."}
                </p>
              )}
              {etat.phase === "error" && <p className="text-destructive">{etat.message}</p>}
              {info?.asset && !seule && (etat.phase === "available" || etat.phase === "ready") && (
                // Dit franchement : l'empreinte prouve que le fichier est arrivé
                // entier, pas qu'il vient de nous.
                <p className="text-[11px] text-muted-foreground/80">
                  The disk image is not signed yet, so {mac ? "macOS" : "Windows"} will warn about it the first
                  time, as it did for this version.
                </p>
              )}
            </div>
          </Dialog.Description>

          <div className="mt-4 flex justify-end gap-2">
            <button className={secondaire} onClick={() => setUpdateDialog(false)}>
              {etat.phase === "available" ? "Later" : "Close"}
            </button>
            {etat.phase === "available" && info?.asset && (
              <button className={principal} onClick={() => void downloadUpdate()}>
                {info.kind === "patch" ? "Update" : "Download"} ({mo(info.asset.size)})
              </button>
            )}
            {etat.phase === "error" && info?.asset && (
              <button className={principal} onClick={() => void downloadUpdate()}>
                Try again
              </button>
            )}
            {etat.phase === "ready" && (
              <button
                className={principal}
                onClick={() =>
                  void installUpdate().then((r) => {
                    if (r === "opened") setUpdateDialog(false)
                  })
                }
              >
                {seule ? "Restart to update" : "Open the disk image"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// La pastille de la barre d'état : là tant qu'une version plus récente
// attend, comme la roue dentée de VS Code.
export function UpdatePill() {
  const etat = useSyncExternalStore(subscribeUpdate, updateState, updateState)
  if (etat.phase !== "available" && etat.phase !== "downloading" && etat.phase !== "ready") return null
  return (
    <button
      className="flex items-center gap-1 rounded px-1 text-sky-300 hover:bg-white/[0.08]"
      title="An update is available"
      onClick={() => setUpdateDialog(true)}
    >
      <ArrowUpCircle className="h-3 w-3" />
      {etat.phase === "downloading" ? "Downloading update…" : etat.phase === "ready" ? "Update ready" : `Update to ${etat.info.latest}`}
    </button>
  )
}
