import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import * as Dialog from "@radix-ui/react-dialog"
import { Download, ExternalLink, FolderOpen, Image as ImageIcon, X } from "lucide-react"
import { cn } from "@/lib/utils"

/** Une image jointe, telle que le rendu la connaît : un nom et un identifiant,
 *  jamais un chemin. */
export type Attached = { id: string; name: string }

function useImage(conversationId: string, image: Attached) {
  return useQuery({
    queryKey: ["agent", "thumb", conversationId, image.id],
    queryFn: () => window.zyvro.agent.thumbnail(conversationId, image.id),
    staleTime: Infinity,
  })
}

// Thumb : l'image elle-même, plutôt que son nom.
//
// Elle est demandée au processus principal par identifiant et revient en
// adresse `data:` — le rendu n'a jamais su où vivent ces fichiers et ce n'est
// pas une vignette qui va le lui apprendre.
//
// Tant qu'elle n'est pas là, et si elle ne vient jamais, c'est l'icône d'avant :
// une conversation rouverte après un ménage ne doit pas s'afficher en rouge
// pour une image disparue.
//
// Dans son propre fichier parce que deux endroits l'utilisent — ce qu'on a
// envoyé et ce que l'agent a montré — et que la version où chacun dessine sa
// vignette est celle où l'une des deux oublie le cas du fichier manquant.
//
// Un clic l'ouvre en grand, avec de quoi la retrouver : son dossier, son
// application, « enregistrer sous ». Demandé par Jeremy pour les images que
// lit un outil — une vignette de vingt pixels ne se regarde pas, elle se
// devine.
export function Thumb({
  conversationId,
  image,
  size,
  source,
}: {
  conversationId: string
  image: Attached
  size: string
  /** Le fichier d'origine, quand un outil l'a lu : « montrer dans le dossier »
   *  montre alors celui-là plutôt que la copie rangée par l'application. */
  source?: string
}): JSX.Element {
  const data = useImage(conversationId, image)
  const [open, setOpen] = useState(false)
  if (!data.data) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded bg-white/[0.06]", size)}>
        <ImageIcon className="h-3 w-3 text-muted-foreground" />
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${image.name} — click to view`}
        className={cn(
          "shrink-0 cursor-zoom-in overflow-hidden rounded border border-white/[0.08] transition hover:border-primary/60 hover:brightness-110",
          size
        )}
      >
        <img src={data.data} alt={image.name} className="h-full w-full object-cover" />
      </button>
      {open && (
        <ImageViewer
          conversationId={conversationId}
          image={image}
          src={data.data}
          source={source}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

// La vue en grand. L'image tient dans la fenêtre sans être déformée ; en
// dessous, ce qu'on fait d'une image qu'on vient de regarder.
function ImageViewer({
  conversationId,
  image,
  src,
  source,
  onClose,
}: {
  conversationId: string
  image: Attached
  src: string
  source?: string
  onClose: () => void
}): JSX.Element {
  const [said, setSaid] = useState("")
  const reveal = useMutation({
    mutationFn: () => window.zyvro.agent.imageReveal(conversationId, image.id, source ?? null),
    onSuccess: (where) => setSaid(where === "original" ? "Shown in its folder." : "Shown in Zyvro's copy of the conversation's images."),
  })
  const openIt = useMutation({
    mutationFn: () => window.zyvro.agent.imageOpen(conversationId, image.id, source ?? null),
  })
  const save = useMutation({
    mutationFn: () => window.zyvro.agent.imageSave(conversationId, image.id, nameOf(image, source), source ?? null),
    onSuccess: (file) => setSaid(file ? `Saved to ${file}` : ""),
  })
  const failure = [reveal, openIt, save].find((m) => m.isError)?.error as Error | undefined
  const title = source ? source : image.name

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-auto max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 outline-none">
          <div className="flex items-center gap-2">
            <Dialog.Title className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/85" title={title}>
              {title}
            </Dialog.Title>
            <Dialog.Close
              className="rounded-md p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              title="Close (Esc)"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">The image at full size, with ways to find or keep it.</Dialog.Description>

          <img
            src={src}
            alt={image.name}
            className="min-h-0 max-h-[78vh] max-w-[92vw] self-center rounded-md border border-white/[0.08] bg-[repeating-conic-gradient(#ffffff0d_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] object-contain"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            <ViewerButton icon={FolderOpen} onClick={() => reveal.mutate()} busy={reveal.isPending}>
              Show in folder
            </ViewerButton>
            <ViewerButton icon={ExternalLink} onClick={() => openIt.mutate()} busy={openIt.isPending}>
              Open
            </ViewerButton>
            <ViewerButton icon={Download} onClick={() => save.mutate()} busy={save.isPending} primary>
              Download
            </ViewerButton>
            {(failure || said) && (
              <span className={cn("ml-1 truncate text-[11px]", failure ? "text-red-300" : "text-muted-foreground")}>
                {failure ? failure.message : said}
              </span>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ViewerButton({
  icon: Icon,
  onClick,
  busy,
  primary,
  children,
}: {
  icon: typeof Download
  onClick: () => void
  busy: boolean
  primary?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "border border-white/[0.1] bg-white/[0.04] text-foreground hover:bg-white/[0.08]"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  )
}

// Le nom proposé à l'enregistrement : celui du fichier lu quand on le connaît,
// sinon celui que l'image porte dans la conversation.
function nameOf(image: Attached, source?: string): string {
  if (source) {
    const parts = source.split(/[/\\]/)
    const last = parts[parts.length - 1]
    if (last) return last
  }
  return image.name
}
