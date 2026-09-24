import type { Menu, MenuItem } from "electron"

// Le menu de l'application, mis à plat pour la palette de commandes (⌘⇧P).
//
// La palette ne tient pas sa propre liste : elle lit celle du menu. Deux
// listes, c'est une commande qui existe dans l'une et pas dans l'autre, et un
// raccourci affiché dans la palette qui n'est plus celui du menu. Ici il n'y a
// qu'une vérité, et la palette en est une autre façon de s'en servir.

export type MenuCommand = {
  /** Le chemin dans le menu, qui sert d'identifiant : « File › Save ». */
  id: string
  label: string
  /** Le chemin des menus parents, pour la palette : « File », « View ». */
  group: string
  /** Tel qu'Electron l'écrit, « CmdOrCtrl+Shift+P » ; le rendu le met en forme. */
  accelerator: string
}

const SEP = " › "

// Les rôles qui n'ont rien à faire dans une palette : ils agissent sur ce qui
// a le focus, et le focus, au moment où l'on choisit dans la palette, c'est la
// palette. « Copy » y copierait la requête.
const HORS_PALETTE = new Set([
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "pasteandmatchstyle",
  "selectall",
  "delete",
  "services",
  "startspeaking",
  "stopspeaking",
])

function labelOf(item: MenuItem): string {
  return (item.label || "").replace(/&/g, "").trim()
}

export function flattenMenu(menu: Menu | null): MenuCommand[] {
  const out: MenuCommand[] = []
  const walk = (items: MenuItem[], parents: string[]) => {
    for (const item of items) {
      if (item.type === "separator" || !item.visible) continue
      const label = labelOf(item)
      if (item.submenu) {
        walk(item.submenu.items, label ? [...parents, label] : parents)
        continue
      }
      if (!label || !item.enabled) continue
      if (item.role && HORS_PALETTE.has(String(item.role).toLowerCase())) continue
      out.push({
        id: [...parents, label].join(SEP),
        label,
        group: parents.join(SEP),
        accelerator: typeof item.accelerator === "string" ? item.accelerator : "",
      })
    }
  }
  if (menu) walk(menu.items, [])
  return out
}

// findMenuItem : l'entrée qu'un identifiant désigne, ou null.
export function findMenuItem(menu: Menu | null, id: string): MenuItem | null {
  if (!menu) return null
  const parts = id.split(SEP)
  let items = menu.items
  let found: MenuItem | null = null
  for (let i = 0; i < parts.length; i++) {
    found = items.find((item) => item.type !== "separator" && labelOf(item) === parts[i]) ?? null
    if (!found) return null
    if (i < parts.length - 1) {
      if (!found.submenu) return null
      items = found.submenu.items
    }
  }
  return found && !found.submenu && found.enabled ? found : null
}
