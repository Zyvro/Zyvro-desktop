/// <reference path="./gifenc.d.ts" />
// Un enregistrement d'écran en GIF, image par image, pendant qu'il se fait.
//
// Le serveur garde la vidéo en WebM et le GIF à côté ; le GIF est fait ici,
// sur la machine qui a les images, plutôt que là-bas avec ffmpeg sur chaque
// téléchargement.
//
// Ce qui le rend tenable : un écran bouge peu. Une image entière par dixième
// de seconde, c'est soixante à cent cinquante kilo-octets par image pour un
// terminal immobile, soit bien plus que les 40 Mo du serveur en une minute.
// Alors chaque image ne réécrit que les pixels qui ont changé depuis ce qui
// est à l'écran ; le reste est transparent et laisse voir l'image d'avant
// (`dispose: 1`). Une zone où rien ne bouge ne coûte presque rien, et une
// image où rien n'a bougé ne s'écrit pas : celle d'avant dure plus longtemps.
//
// Les délais sont les vrais : chaque image dure jusqu'à l'arrivée de la
// suivante, et la dernière jusqu'à l'arrêt. Le GIF dure ce qu'a duré
// l'enregistrement, ce que le serveur vérifie.
//
// Pur — pas de DOM, pas d'Electron — pour `scripts/check-capture.mjs`.

import { GIFEncoder, applyPalette, quantize, type Palette } from "gifenc"

/** En dessous, un écart de couleur est du bruit d'encodage, pas un changement. */
const THRESHOLD = 24

type Pending = { index: Uint8Array; palette: Palette; transparentIndex: number | null; at: number }

export class GifClip {
  private readonly encoder = GIFEncoder()
  /** Ce que le GIF montre en ce moment, en RGB : la référence des écarts. */
  private shown: Uint8Array | null = null
  private pending: Pending | null = null
  private over = false
  frames = 0

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly maxBytes: number
  ) {}

  /** Trop lourd pour le serveur : on arrête d'y ajouter, il n'y aura pas de GIF. */
  get tooLarge(): boolean {
    return this.over
  }

  add(rgba: Uint8Array | Uint8ClampedArray, at: number): void {
    if (this.over) return
    const n = this.width * this.height
    if (rgba.length < n * 4) throw new Error("frame is smaller than the clip")

    if (!this.shown) {
      const palette = quantize(rgba, 256)
      const index = applyPalette(rgba, palette)
      this.shown = new Uint8Array(n * 3)
      for (let i = 0; i < n; i++) {
        const c = palette[index[i]]
        this.shown[i * 3] = c[0]
        this.shown[i * 3 + 1] = c[1]
        this.shown[i * 3 + 2] = c[2]
      }
      this.pending = { index, palette, transparentIndex: null, at }
      return
    }

    const shown = this.shown
    const changed: number[] = []
    for (let i = 0; i < n; i++) {
      const p = i * 4
      const q = i * 3
      const d =
        Math.abs(rgba[p] - shown[q]) + Math.abs(rgba[p + 1] - shown[q + 1]) + Math.abs(rgba[p + 2] - shown[q + 2])
      if (d > THRESHOLD) changed.push(i)
    }
    if (changed.length === 0) return

    const subset = new Uint8Array(changed.length * 4)
    for (let k = 0; k < changed.length; k++) {
      const p = changed[k] * 4
      subset[k * 4] = rgba[p]
      subset[k * 4 + 1] = rgba[p + 1]
      subset[k * 4 + 2] = rgba[p + 2]
      subset[k * 4 + 3] = 255
    }
    // 255 couleurs pour les pixels, la 256e est le trou.
    const palette = quantize(subset, 255)
    const mapped = applyPalette(subset, palette)
    const transparentIndex = palette.length
    palette.push([0, 0, 0])
    const index = new Uint8Array(n).fill(transparentIndex)
    for (let k = 0; k < changed.length; k++) {
      const i = changed[k]
      const c = palette[mapped[k]]
      index[i] = mapped[k]
      shown[i * 3] = c[0]
      shown[i * 3 + 1] = c[1]
      shown[i * 3 + 2] = c[2]
    }
    this.flush(at)
    this.pending = { index, palette, transparentIndex, at }
  }

  /** Le GIF, ou null s'il a dépassé ce que le serveur accepte. */
  finish(at: number): Uint8Array | null {
    this.flush(at)
    this.pending = null
    if (this.over || this.frames === 0) return null
    this.encoder.finish()
    return this.encoder.bytes()
  }

  private flush(now: number): void {
    const p = this.pending
    if (!p || this.over) return
    this.encoder.writeFrame(p.index, this.width, this.height, {
      palette: p.palette,
      // Deux centièmes au moins : en dessous, un navigateur affiche un dixième.
      delay: Math.max(20, now - p.at),
      transparent: p.transparentIndex !== null,
      transparentIndex: p.transparentIndex ?? 0,
      // Laisser l'image en place : la suivante ne peint que ce qui change.
      dispose: 1,
      repeat: 0,
    })
    this.frames++
    if (this.encoder.bytesView().length > this.maxBytes) this.over = true
  }
}
