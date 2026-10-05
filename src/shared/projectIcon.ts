// L'icône générée d'un projet : deux lettres sur une couleur.
//
// Quand plusieurs projets sont ouverts, la question avant d'envoyer un prompt
// est « où va-t-il ? ». Un nom se lit ; une couleur se reconnaît sans lire. Ce
// qu'on génère doit donc être stable — le même projet a toujours la même
// couleur, d'une fenêtre à l'autre et d'un lancement à l'autre — et différent
// d'un projet à l'autre autant que possible.
//
// La couleur vient du chemin et pas du nom : deux dossiers `app` ouverts côte à
// côte sont justement le cas où il faut les distinguer. Les lettres viennent
// du nom, parce que c'est ce qu'on lit.
//
// Partagé par le principal et le rendu, donc n'importe rien.

export type GeneratedIcon = { letters: string; background: string; foreground: string }

/** FNV-1a sur 32 bits : rapide, stable, et assez dispersé pour une teinte. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Les mots d'un nom de dossier : `my-app`, `my_app`, `myApp`, `My App`. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export function projectLetters(name: string): string {
  const parts = words(name)
  if (parts.length === 0) return "?"
  if (parts.length === 1) {
    const [first, second] = [...parts[0]]
    return (first + (second ?? "")).toUpperCase()
  }
  return ([...parts[0]][0] + [...parts[1]][0]).toUpperCase()
}

export function generatedIcon(name: string, path: string): GeneratedIcon {
  const h = hash(path || name)
  // Des teintes franches mais pas criardes, et assez sombres pour des lettres
  // blanches lisibles à 16 pixels.
  const hue = h % 360
  const saturation = 55 + ((h >>> 9) % 15)
  const lightness = 38 + ((h >>> 17) % 8)
  return {
    letters: projectLetters(name),
    background: `hsl(${hue} ${saturation}% ${lightness}%)`,
    foreground: "#fff",
  }
}

/** Où vit l'icône choisie, relatif à la racine du projet : avec lui, dans
 *  `.zyvro/`, pour qu'un collègue qui clone le dépôt la voie aussi. */
export const PROJECT_ICON_FILE = ".zyvro/icon.png"

/** Le côté du carré qu'on garde : de quoi être net en 2x à 48 pixels. */
export const PROJECT_ICON_SIZE = 128
