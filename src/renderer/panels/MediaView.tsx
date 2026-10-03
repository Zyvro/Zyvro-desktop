import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Music } from "lucide-react"
import { mediaKindOf } from "../../shared/media"

// MediaView : une vidéo ou un son ouvert depuis l'arbre.
//
// Avant, un .mp4 tombait sur « fichier binaire » : rien à voir, rien à
// entendre. Le lecteur est celui de Chromium, avec ses commandes — lecture,
// position, volume, plein écran, vitesse. L'adresse vient du principal
// (main/media.ts), qui sert le fichier par morceaux : on saute au milieu d'une
// vidéo de 2 Go sans la charger.
//
// Ce que Chromium ne décode pas (l'AVI, des MKV en H.265…) le dit, et
// s'ouvre dans le lecteur du système d'un clic plutôt que de rester noir.
export function MediaView({ path }: { path: string }): JSX.Element {
  const kind = mediaKindOf(path) ?? "video"
  const adresse = useQuery({
    queryKey: ["files", "media", path],
    queryFn: () => window.zyvro.files.mediaUrl(path),
    staleTime: Infinity,
  })
  // Une erreur de décodage, pour cette adresse : rouvrir le fichier réessaie.
  const [illisible, setIllisible] = useState<string | null>(null)
  const nom = path.split(/[\\/]/).pop() ?? path
  const reveler = window.zyvro.platform === "darwin" ? "Reveal in Finder" : "Reveal in File Explorer"

  if (adresse.isError) {
    return <Message title="This file cannot be opened.">{(adresse.error as Error).message}</Message>
  }
  if (!adresse.data) return <div className="h-full" />

  if (illisible === adresse.data) {
    return (
      <Message title={`${nom} cannot be played here.`}>
        <p>This app plays MP4, WebM, MOV (H.264), MP3, WAV, OGG, FLAC and M4A. This format or codec is not supported.</p>
        <div className="mt-3 flex justify-center gap-2">
          <button
            className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => void window.zyvro.files.openExternally(path)}
          >
            Open with Default App
          </button>
          <button
            className="rounded-md border border-white/[0.1] px-3 py-1.5 text-[12px] hover:bg-white/[0.06]"
            onClick={() => void window.zyvro.files.reveal(path)}
          >
            {reveler}
          </button>
        </div>
      </Message>
    )
  }

  const onError = (): void => setIllisible(adresse.data)

  return (
    // `color-scheme: dark` : les commandes du lecteur suivent le thème, au
    // lieu d'une barre blanche au milieu de l'éditeur.
    <div className="zy-media flex h-full min-h-0 flex-col items-center justify-center gap-3 bg-black/40 p-4 [color-scheme:dark]">
      {kind === "video" ? (
        <video
          key={adresse.data}
          src={adresse.data}
          controls
          preload="metadata"
          onError={onError}
          className="max-h-full max-w-full rounded-md bg-black shadow-lg outline-none"
        />
      ) : (
        <div className="flex w-full max-w-xl flex-col items-center gap-4 rounded-lg border border-white/[0.08] bg-white/[0.03] p-6">
          <Music className="h-10 w-10 text-muted-foreground" aria-hidden />
          <div className="max-w-full truncate text-[13px] text-foreground" title={path}>
            {nom}
          </div>
          <audio key={adresse.data} src={adresse.data} controls preload="metadata" onError={onError} className="w-full" />
        </div>
      )}
    </div>
  )
}

function Message({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center text-[12px] text-muted-foreground">
        <div className="mb-2 text-[13px] font-medium text-foreground">{title}</div>
        {children}
      </div>
    </div>
  )
}
