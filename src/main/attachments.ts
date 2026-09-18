import { app } from "electron"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { IMAGE_EXTENSIONS, dataUri, kindOf } from "../shared/image"

// Images handed to the agent.
//
// Both CLIs want a file on disk and neither takes bytes: codex has
// `-i <FILE>...`, and claude has no image flag at all — it reads an image by
// path with its Read tool, which was checked rather than assumed ("lis
// ./logo.png" → "Icône d'application Z", tool used: Read). So whatever arrives,
// pasted or dropped or picked, becomes a file first.
//
// Where that file goes was the open question. In the project it would end up
// committed — a screenshot pasted to explain a bug is not part of anybody's
// repository. So it lives beside the conversation it belongs to, under this
// app's own folder, and is deleted with it. That also answers the cleanup
// question without a sweeper: a conversation you close takes its images away.

// A screenshot of a 6K display is a few megabytes; a hundred is somebody's
// mistake, and both CLIs would choke on it long before this app did.
const MAX_BYTES = 20 * 1024 * 1024

export type Attachment = {
  id: string
  name: string
  mime: string
  /** Absolute, and only ever handed to the CLI — never to the renderer. */
  file: string
}

// Ce qui fait qu'une suite d'octets est une image vit dans un module partagé :
// quatre endroits posent la question, et une deuxième table de signatures
// serait celle qui ignore le format ajouté dans l'autre.
export { kindOf } from "../shared/image"

function folder(conversationId: string): string {
  // The id is ours — generated in the renderer from a timestamp and random
  // characters — but it still crosses IPC, so it is reduced to what a directory
  // name may contain rather than trusted to be one.
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unfiled"
  return path.join(app.getPath("userData"), "attachments", safe)
}

// keep writes one image and answers with what the CLI will be given.
export async function keep(
  conversationId: string,
  name: string,
  bytes: Uint8Array
): Promise<Attachment> {
  if (bytes.length === 0) throw new Error("That file is empty.")
  if (bytes.length > MAX_BYTES) {
    throw new Error(`That image is ${Math.round(bytes.length / 1024 / 1024)} MB; the limit is 20 MB.`)
  }
  const kind = kindOf(bytes)
  if (!kind) {
    throw new Error("That is not an image this app recognises — PNG, JPEG, GIF and WebP are.")
  }

  const dir = folder(conversationId)
  await fs.mkdir(dir, { recursive: true })
  const id = randomUUID()
  // The name the person sees keeps whatever they called it; the name on disk is
  // ours, so nothing they pasted decides a path.
  const file = path.join(dir, `${id}.${kind.extension}`)
  await fs.writeFile(file, bytes)

  return { id, name: displayName(name, kind.extension), mime: kind.mime, file }
}

// displayName is what the chip above the composer says. A pasted image has no
// name of its own, and "image.png" said three times is three chips nobody can
// tell apart, so an unnamed one is dated instead.
export function displayName(name: string, extension: string): string {
  const trimmed = path.basename(name ?? "").trim()
  if (trimmed && trimmed !== "." && trimmed !== "..") return trimmed
  const now = new Date()
  const stamp = `${now.getHours()}`.padStart(2, "0") + `${now.getMinutes()}`.padStart(2, "0") + `${now.getSeconds()}`.padStart(2, "0")
  return `pasted-${stamp}.${extension}`
}

// drop removes everything kept for one conversation. Called when it is
// forgotten, which is what keeps this folder from growing forever without a
// sweeper to write and forget about.
export async function drop(conversationId: string): Promise<void> {
  await fs.rm(folder(conversationId), { recursive: true, force: true })
}

// forget removes one image, for the cross on its chip.
export async function forget(conversationId: string, id: string): Promise<void> {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, "")
  if (!safe) return
  const dir = folder(conversationId)
  for (const entry of await fs.readdir(dir).catch(() => [])) {
    if (entry.startsWith(`${safe}.`)) await fs.rm(path.join(dir, entry), { force: true })
  }
}

// pathsFor turns the ids the renderer holds into the paths the CLI is given.
//
// This is the gate. The renderer never sees or sends a path: it names an
// attachment by an id, and only a file this process wrote under this
// conversation's own folder can come back out. Without it, "here is an image to
// read" would be a way to ask the agent to read any file on the machine.
// thumbnail rend l'image d'une pièce jointe, prête à être affichée.
//
// Le chemin, lui, ne sort toujours pas d'ici : le rendu nomme une pièce jointe
// par son identifiant et reçoit une adresse `data:`. C'est la règle depuis le
// début — un rendu qui nomme un chemin est un rendu qui peut demander
// `/etc/passwd` en l'appelant une image — et la vignette ne l'entame pas.
//
// Rien plutôt qu'une erreur quand elle a disparu : une conversation qu'on
// rouvre après avoir vidé le dossier ne doit pas s'afficher en rouge pour une
// vignette manquante.
export async function thumbnail(conversationId: string, id: string): Promise<string | null> {
  const [file] = pathsFor(conversationId, [id])
  if (!file) return null
  try {
    const bytes = await fs.readFile(file)
    const kind = kindOf(bytes)
    if (!kind) return null
    return dataUri(kind.mime, bytes)
  } catch {
    return null
  }
}

export function pathsFor(conversationId: string, ids: string[]): string[] {
  const dir = folder(conversationId)
  const out: string[] = []
  for (const id of ids) {
    const safe = id.replace(/[^a-zA-Z0-9-]/g, "")
    if (!safe) continue
    for (const extension of IMAGE_EXTENSIONS) {
      const file = path.join(dir, `${safe}.${extension}`)
      if (existsSync(file)) {
        out.push(file)
        break
      }
    }
  }
  return out
}
