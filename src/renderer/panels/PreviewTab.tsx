import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { Markdown } from "@/components/Markdown"
import { useWorkspace } from "~/state/workspace"

// L'aperçu d'un fichier Markdown (⌘⇧V), comme dans VS Code.
//
// Le rendu est celui du chat — le composant du site, qui construit des éléments
// React et ne passe jamais par du HTML brut : un README venu d'ailleurs ne peut
// pas glisser de balise dans la fenêtre. Il suit le texte pendant qu'on l'écrit :
// le brouillon de l'onglet d'édition s'il y en a un, sinon le fichier, par la
// même requête que l'éditeur — donc relu quand on enregistre.

export function PreviewTab({ path }: { path: string }) {
  const brouillon = useWorkspace((s) => s.drafts[`file:${path}`])
  const file = useQuery({
    queryKey: ["files", "read", path],
    queryFn: () => window.zyvro.files.read(path),
    staleTime: Infinity,
  })
  const texte = brouillon ?? (file.data && "text" in file.data ? file.data.text : null)

  if (texte === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        {file.isError ? (
          (file.error as Error).message
        ) : (
          <>
            <Loader2 className="h-4 w-4 zy-spin" /> Opening {path}
          </>
        )}
      </div>
    )
  }
  return (
    <div className="zy-scroll h-full overflow-y-auto">
      <article className="mx-auto max-w-3xl px-8 py-8 text-[14px] leading-relaxed">
        <Markdown text={texte} />
      </article>
    </div>
  )
}
