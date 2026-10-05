// L'icône choisie d'un projet : lue, posée, retirée.
//
// Elle vit dans le projet (`.zyvro/icon.png`) et pas dans les réglages de
// l'application : c'est une propriété du projet, que le dépôt emporte avec lui.
// Une image choisie est recadrée au carré par le centre et réduite à 128 px
// avant d'être écrite — une photo de 12 Mo n'a rien à faire dans un dépôt, et
// le panneau la montre à 16 pixels.

import { promises as fs } from "node:fs"
import path from "node:path"
import { nativeImage } from "electron"
import { PROJECT_ICON_FILE, PROJECT_ICON_SIZE } from "../shared/projectIcon"

function iconPath(root: string): string {
  return path.join(root, ...PROJECT_ICON_FILE.split("/"))
}

/** L'icône en data URL, ou null quand le projet n'en a pas choisi. */
export async function readProjectIcon(root: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(iconPath(root))
    return `data:image/png;base64,${bytes.toString("base64")}`
  } catch {
    return null
  }
}

/**
 * Pose l'image `source` comme icône du projet. Rend la data URL écrite.
 *
 * Ce que `nativeImage` ne sait pas lire est refusé avec un message qui dit
 * quoi choisir, plutôt que d'écrire un fichier vide qu'on prendrait pour une
 * icône.
 */
export async function setProjectIcon(root: string, source: string): Promise<string> {
  const image = nativeImage.createFromPath(source)
  if (image.isEmpty()) throw new Error("That file is not an image Zyvro can read. Choose a PNG or a JPEG.")
  const { width, height } = image.getSize()
  const side = Math.min(width, height)
  const square = image.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
  const png = square.resize({ width: PROJECT_ICON_SIZE, height: PROJECT_ICON_SIZE, quality: "best" }).toPNG()
  const target = iconPath(root)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.partial`
  await fs.writeFile(temp, png)
  await fs.rename(temp, target)
  return `data:image/png;base64,${png.toString("base64")}`
}

/** Revient à l'icône générée. */
export async function clearProjectIcon(root: string): Promise<void> {
  await fs.rm(iconPath(root), { force: true })
}
