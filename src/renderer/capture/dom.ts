// Un élément et ses propriétés, en une ligne. Pas de innerHTML : rien de ce
// qui s'affiche ici n'est interprété comme du balisage, un chemin de fichier
// ou un lien compris.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}
