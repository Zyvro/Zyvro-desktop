import { protocol } from "electron"
import fs from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { mediaMime, parseRange } from "../shared/media"

// Les vidéos et les sons, servis au lecteur de la fenêtre.
//
// Pas en `data:` comme les images : une vidéo de 500 Mo passerait entière par
// l'IPC, gonflée d'un tiers, avant la première image. Un lecteur veut une
// adresse qu'il interroge par morceaux (`Range`) — c'est ce qui permet de
// sauter au milieu sans tout charger.
//
// L'adresse ne porte pas le chemin. La fenêtre demande un fichier du projet
// par l'IPC, qui le vérifie (dedans, ou accordé) et rend un jeton ; seul un
// jeton émis ici ouvre un fichier. Sans ça, `zyvro-media://…/etc/passwd`
// serait une façon de lire n'importe quoi.

export const MEDIA_SCHEME = "zyvro-media"
const MAX_JETONS = 500

const jetons = new Map<string, string>()

/** Avant `app.whenReady` : un schéma qui streame, comme `https:`. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ])
}

/** L'adresse d'un fichier déjà vérifié par l'appelant. */
export function mediaUrlFor(file: string): string {
  const jeton = randomUUID()
  jetons.set(jeton, file)
  // Les plus anciens partent : un onglet ouvert il y a cinq cents fichiers
  // redemandera le sien.
  while (jetons.size > MAX_JETONS) jetons.delete(jetons.keys().next().value as string)
  return `${MEDIA_SCHEME}://media/${jeton}/${encodeURIComponent(path.basename(file))}`
}

/** Après `app.whenReady`. */
export function handleMedia(): void {
  protocol.handle(MEDIA_SCHEME, serve)
}

export async function serve(request: Request): Promise<Response> {
  const jeton = new URL(request.url).pathname.split("/")[1] ?? ""
  const file = jetons.get(jeton)
  if (!file) return new Response("Not found", { status: 404 })
  let size: number
  try {
    const stat = await fs.promises.stat(file)
    if (!stat.isFile()) return new Response("Not found", { status: 404 })
    size = stat.size
  } catch {
    return new Response("Not found", { status: 404 })
  }
  const type = mediaMime(file)
  const plage = parseRange(request.headers.get("range"), size)
  if (plage === "invalid") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
  }
  const { start, end } = plage ?? { start: 0, end: Math.max(0, size - 1) }
  const corps =
    size === 0 ? null : (Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>)
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": String(size === 0 ? 0 : end - start + 1),
  }
  if (plage) headers["Content-Range"] = `bytes ${start}-${end}/${size}`
  return new Response(corps, { status: plage ? 206 : 200, headers })
}
