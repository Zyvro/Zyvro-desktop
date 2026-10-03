// gifenc ne publie pas de types. Ce qu'on en utilise, et rien de plus.
declare module "gifenc" {
  export type Palette = number[][]
  export type FrameOptions = {
    palette?: Palette
    delay?: number
    transparent?: boolean
    transparentIndex?: number
    repeat?: number
    dispose?: number
    first?: boolean
  }
  export type Encoder = {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: FrameOptions): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: Record<string, unknown>): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array
}
