import { useQuery } from "@tanstack/react-query"
import { Image as ImageIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** Une image jointe, telle que le rendu la connaît : un nom et un identifiant,
 *  jamais un chemin. */
export type Attached = { id: string; name: string }

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
export function Thumb({
  conversationId,
  image,
  size,
}: {
  conversationId: string
  image: Attached
  size: string
}): JSX.Element {
  const data = useQuery({
    queryKey: ["agent", "thumb", conversationId, image.id],
    queryFn: () => window.zyvro.agent.thumbnail(conversationId, image.id),
    staleTime: Infinity,
  })
  if (!data.data) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded bg-white/[0.06]", size)}>
        <ImageIcon className="h-3 w-3 text-muted-foreground" />
      </span>
    )
  }
  return (
    <img
      src={data.data}
      alt={image.name}
      title={image.name}
      className={cn("shrink-0 rounded border border-white/[0.08] object-cover", size)}
    />
  )
}
