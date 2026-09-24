import { memo } from "react"
import theme from "material-icon-theme/dist/material-icons.json"
// Le Monaco de l'application, celui où les langues sont inscrites.
import { monaco } from "./monaco"
import { fileIconName, folderIconName, iconFile, type IconTheme } from "../../shared/fileicons"

// Les icônes par type de fichier, celles de Material Icon Theme (MIT — voir
// THIRD-PARTY-NOTICES.md), dans l'arbre, les onglets et Quick Open.
//
// Les fichiers SVG sont émis par Vite à côté du rendu, un par icône, et
// chargés par le navigateur seulement quand une ligne en montre un : les mille
// deux cents ne coûtent que leur adresse tant qu'on ne les voit pas.

// `?no-inline` : sans lui Vite met chaque petite icône en `data:` dans le
// bundle — mesuré, 1,7 Mo de JavaScript de plus à lire à chaque démarrage pour
// des images dont on ne voit qu'une vingtaine à la fois.
const URLS = import.meta.glob("../../../node_modules/material-icon-theme/icons/*.svg", {
  query: "?no-inline",
  import: "default",
  eager: true,
}) as Record<string, string>

const parNom = new Map<string, string>()
for (const [chemin, url] of Object.entries(URLS)) {
  parNom.set(chemin.slice(chemin.lastIndexOf("/") + 1), url)
}

const THEME = theme as unknown as IconTheme

// L'extension → la langue, telle que Monaco la connaît. Pour les extensions que
// le thème ne nomme pas mais dont il connaît la langue.
let langues: Map<string, string> | null = null
function langueDe(extension: string): string | undefined {
  if (!langues) {
    langues = new Map()
    for (const l of monaco.languages.getLanguages()) {
      for (const e of l.extensions ?? []) langues.set(e.replace(/^\./, "").toLowerCase(), l.id)
    }
  }
  return langues.get(extension)
}

// Par la table des définitions : le nom d'une icône n'est pas toujours celui
// de son fichier.
function urlDe(icon: string, repli: string): string | undefined {
  const fichier = iconFile(THEME, icon) ?? iconFile(THEME, repli)
  return fichier ? parNom.get(fichier) : undefined
}

export function fileIconUrl(name: string): string | undefined {
  return urlDe(fileIconName(THEME, name, langueDe), THEME.file)
}

export function folderIconUrl(name: string, open: boolean): string | undefined {
  return urlDe(folderIconName(THEME, name, open), open ? THEME.folderExpanded : THEME.folder)
}

// L'icône elle-même. `draggable={false}` : sans ça, attraper une ligne de
// l'arbre par son icône ferait glisser l'image au lieu du fichier.
export const FileTypeIcon = memo(function FileTypeIcon({
  name,
  folder = false,
  open = false,
  className = "h-4 w-4",
}: {
  name: string
  folder?: boolean
  open?: boolean
  className?: string
}) {
  const url = folder ? folderIconUrl(name, open) : fileIconUrl(name)
  if (!url) return null
  return <img src={url} alt="" aria-hidden draggable={false} className={`${className} shrink-0`} />
})
