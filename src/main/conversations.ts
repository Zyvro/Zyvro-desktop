import { app } from "electron"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import type { AgentKind } from "./agent"

// What the agent panel remembers between runs.
//
// Two things, and they have to be kept together or neither is worth having.
// The CLI's session id, which is what makes the agent remember — `claude
// --resume <id>` and `codex exec resume <id>` both pick a conversation back up
// where it stopped. And the transcript, which is what makes the person
// remember.
//
// Storing only the session id would be worse than storing nothing: the panel
// would open empty while the agent still held every word of a conversation the
// person can no longer see. An assistant that remembers more than its window
// shows is an assistant nobody can predict.
//
// Kept beside the account rather than inside the project: which conversations
// you have had is a fact about you, and a .zyvro folder that filled up with
// chat logs would end up committed.

// A tool call as the transcript keeps it. The name alone was kept before, and
// a conversation reopened tomorrow then said "ran Edit" about work whose
// details were gone — the same loss the panel had while it ran, made permanent.
export type StoredTool = {
  callId: string
  /** The past-tense sentence, which is what the row shows. */
  done: string
  shape: string
  detail: string
  output: string
  isError: boolean
  plan?: { title: string; status: string }[]
}

// Un message assistant est une suite de morceaux, dans l'ordre où ils sont
// arrivés : il parle, il appelle un outil, il reparle.
//
// Une seule liste, et c'est le point. Le panneau en tenait deux — le texte d'un
// côté, les outils de l'autre — et les affichait l'une après l'autre : tous les
// outils en haut, toute la prose en dessous. L'ordre réel était perdu à
// l'écriture, pas à l'affichage, donc aucune mise en forme ne pouvait le
// rattraper.
export type StoredPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; call: StoredTool }

export type StoredMessage = {
  role: "user" | "assistant"
  // `parts` est la forme d'aujourd'hui. `text` et `tools` sont celle d'hier :
  // elles restent lues — une conversation de la semaine dernière vaut d'être
  // rouverte — et ne sont plus écrites. Un transcript ancien se relit dans
  // l'ordre qu'il avait à l'époque : les outils, puis le texte.
  parts?: StoredPart[]
  text?: string
  // Old transcripts hold a list of names. Read rather than migrated: a
  // conversation from last week is worth reopening even if its tool rows can
  // only say what they knew then.
  tools?: (StoredTool | string)[]
  error?: string
}

export type Conversation = {
  id: string
  kind: AgentKind
  title: string
  // The CLI's own id for this thread, learned from its output stream. Null
  // until the first turn has run: there is nothing to resume before then.
  sessionId: string | null
  // The model this thread is pinned to, or null for whatever the CLI picks.
  //
  // Null is a real answer and not a missing one: the default belongs to the
  // CLI, it changes without asking us, and a thread that recorded today's
  // default as a choice would quietly stop following it tomorrow.
  //
  // Per conversation rather than per app, because switching model mid-thread
  // is a thing people do deliberately — start on the fast one, move to the
  // careful one when it gets hard.
  model: string | null
  // What the CLI reported actually running, so the picker can show the default
  // by name instead of the word "default".
  ranWith?: string | null
  messages: StoredMessage[]
  updatedAt: string
}

// A project's conversations live in one file named after the project path.
// Hashed rather than escaped, because a path is not a filename: it has
// separators, it can be longer than a filename may be, and on macOS it can
// carry characters the filesystem normalises behind your back.
function fileFor(projectDir: string): string {
  const key = createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 16)
  return path.join(app.getPath("userData"), "conversations", `${key}.json`)
}

export async function load(projectDir: string): Promise<Conversation[]> {
  try {
    const raw = await fs.readFile(fileFor(projectDir), "utf8")
    const parsed = JSON.parse(raw) as { conversations?: Conversation[] }
    return Array.isArray(parsed.conversations) ? parsed.conversations : []
  } catch {
    // No file, unreadable file, half-written file: all of them mean the same
    // thing to the panel, which is that this project has no history yet. A
    // chat log is not worth failing to open a window over.
    return []
  }
}

export async function save(projectDir: string, conversations: Conversation[]): Promise<void> {
  const file = fileFor(projectDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Written beside and renamed: a crash halfway through a write would
  // otherwise leave a truncated file, and the next load would quietly report
  // an empty history for a project with months of it.
  const temp = `${file}.partial`
  await fs.writeFile(temp, JSON.stringify({ conversations }, null, 2), "utf8")
  await fs.rename(temp, file)
}

// remember updates one conversation in place, creating it if it is new.
export async function remember(projectDir: string, conversation: Conversation): Promise<void> {
  const all = await load(projectDir)
  const index = all.findIndex((c) => c.id === conversation.id)
  const next = { ...conversation, updatedAt: new Date().toISOString() }
  if (index === -1) all.unshift(next)
  else all[index] = next
  await save(projectDir, all)
}

export async function forget(projectDir: string, id: string): Promise<void> {
  await save(
    projectDir,
    (await load(projectDir)).filter((c) => c.id !== id)
  )
}

// titleFrom names a conversation after what was first asked of it, which is
// what a person recognises in a list. One line, and short enough to read in a
// tab.
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n").find((l) => l.trim()) ?? ""
  const clean = line.trim().replace(/\s+/g, " ")
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean || "New chat"
}
