// Quelle icône pour quel fichier, selon les règles d'un thème d'icônes de VS Code.
//
// L'arbre montrait la même icône pour tout, teintée par extension. VS Code et
// Cursor en ont une par type — le logo de TypeScript, celui de Go, un
// `package.json` vert — et c'est ce qui fait qu'on trouve un fichier du coin
// de l'œil avant d'avoir lu son nom. Les icônes et leur table sont celles de
// Material Icon Theme (MIT), le thème le plus installé des deux éditeurs ; ce
// module n'en est que la lecture.
//
// L'ordre est celui de VS Code, et il compte :
//
// 1. le nom exact (`package.json`, `Dockerfile`, `.gitignore`), sans casse ;
// 2. l'extension la plus longue d'abord : `button.spec.ts` est un test avant
//    d'être du TypeScript, `index.d.ts` une déclaration ;
// 3. la langue, quand l'extension n'est connue que d'elle ;
// 4. l'icône par défaut.
//
// Pur, et la table passée en argument : `scripts/check-fileicons.mjs` le
// vérifie sur la vraie table du paquet.

export type IconTheme = {
  /** Le nom d'une icône → son fichier. Pas toujours `<nom>.svg` : certaines
   *  sont des variantes (`sty.clone.svg`). */
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderExpanded: string
  fileExtensions: Record<string, string>
  fileNames: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  languageIds: Record<string, string>
}

export function fileIconName(
  theme: IconTheme,
  name: string,
  languageOf?: (extension: string) => string | undefined
): string {
  const bas = name.toLowerCase()
  const exact = theme.fileNames[bas] ?? theme.fileNames[name]
  if (exact) return exact

  // Toutes les extensions possibles, de la plus longue à la plus courte :
  // `a.spec.ts` → `spec.ts`, puis `ts`. Un nom qui commence par un point
  // (`.eslintrc`) a pour extension ce qui suit ce point.
  const parts = bas.split(".")
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".")
    if (!ext) continue
    const icon = theme.fileExtensions[ext]
    if (icon) return icon
  }

  if (languageOf && parts.length > 1) {
    const language = languageOf(parts[parts.length - 1])
    const icon = language ? theme.languageIds[language] : undefined
    if (icon) return icon
  }
  return theme.file
}

export function folderIconName(theme: IconTheme, name: string, open: boolean): string {
  const bas = name.toLowerCase()
  if (open) return theme.folderNamesExpanded[bas] ?? theme.folderExpanded
  return theme.folderNames[bas] ?? theme.folder
}

// iconFile : le nom du fichier SVG d'une icône, `typescript.svg`, ou null quand
// la table ne la définit pas.
export function iconFile(theme: IconTheme, icon: string): string | null {
  const chemin = theme.iconDefinitions[icon]?.iconPath
  return chemin ? chemin.slice(chemin.lastIndexOf("/") + 1) : null
}
