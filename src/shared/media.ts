// Ce qui se lit et s'écoute : vidéo et son, ouverts depuis l'arbre.
//
// Par l'extension, et pas par les octets comme les images : un lecteur ne lit
// pas le fichier entier pour s'ouvrir, il le demande par morceaux, et c'est
// Chromium qui dira s'il sait le décoder. Ce qu'il ne sait pas lire — l'AVI,
// certains MKV — s'ouvre dans le lecteur du système, d'un clic.

export type MediaKind = "video" | "audio"

const TYPES: Record<string, { kind: MediaKind; mime: string }> = {
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  webm: { kind: "video", mime: "video/webm" },
  mkv: { kind: "video", mime: "video/x-matroska" },
  avi: { kind: "video", mime: "video/x-msvideo" },
  ogv: { kind: "video", mime: "video/ogg" },
  "3gp": { kind: "video", mime: "video/3gpp" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  oga: { kind: "audio", mime: "audio/ogg" },
  opus: { kind: "audio", mime: "audio/ogg" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  aac: { kind: "audio", mime: "audio/aac" },
  flac: { kind: "audio", mime: "audio/flac" },
  weba: { kind: "audio", mime: "audio/webm" },
}

function extension(file: string): string {
  const nom = file.split(/[\\/]/).pop() ?? ""
  const point = nom.lastIndexOf(".")
  return point <= 0 ? "" : nom.slice(point + 1).toLowerCase()
}

/** Vidéo, son, ou null pour tout le reste. */
export function mediaKindOf(file: string): MediaKind | null {
  return TYPES[extension(file)]?.kind ?? null
}

export function mediaMime(file: string): string {
  return TYPES[extension(file)]?.mime ?? "application/octet-stream"
}

/**
 * La plage demandée par un lecteur (`Range: bytes=…`), bornée à la taille du
 * fichier. Rend null sans en-tête — tout le fichier —, et "invalid" pour une
 * plage hors du fichier, qui appelle un 416.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === "" && m[2] === "")) return "invalid"
  let start: number
  let end: number
  if (m[1] === "") {
    // `bytes=-500` : les 500 derniers octets.
    const suffixe = Number(m[2])
    if (suffixe === 0) return "invalid"
    start = Math.max(0, size - suffixe)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return "invalid"
  return { start, end }
}
