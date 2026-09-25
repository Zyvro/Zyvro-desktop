import { ChevronRight } from "lucide-react"
import { FileTypeIcon } from "~/lib/fileIcons"
import { openQuickOpen } from "~/panels/QuickOpen"
import { isAbsolutePath } from "../../shared/external"

// Le fil d'Ariane au-dessus de l'éditeur, comme VS Code : où est le fichier
// qu'on lit, dossier par dossier.
//
// Un dossier du fil ouvre Go to File déjà filtré sur lui — la liste de ce
// qu'il contient, qu'on affine en tapant — plutôt qu'un menu de plus : c'est
// le geste du sélecteur de VS Code, avec l'outil qui existe déjà.

//
// Un fichier hors du projet montre tout son chemin, sans boutons : Go to File
// ne connaît que le projet.
export function Breadcrumbs({ path }: { path: string }) {
  const dehors = isAbsolutePath(path)
  const parts = path.split("/").filter((p, i) => p !== "" || i > 0)
  return (
    <nav className="flex h-6 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/[0.04] px-3 text-[12px] text-muted-foreground">
      {parts.map((part, i) => {
        const dernier = i === parts.length - 1
        const dossier = parts.slice(0, i + 1).join("/")
        return (
          <span key={dossier} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" />}
            {dernier ? (
              <span className="flex items-center gap-1 text-foreground/90">
                <FileTypeIcon name={part} className="h-3.5 w-3.5" />
                {part}
              </span>
            ) : dehors ? (
              <span className="px-0.5">{part}</span>
            ) : (
              <button
                className="rounded px-0.5 hover:bg-white/[0.06] hover:text-foreground"
                title={`Files in ${dossier}`}
                onClick={() => openQuickOpen(`${dossier}/`)}
              >
                {part}
              </button>
            )}
          </span>
        )
      })}
    </nav>
  )
}
