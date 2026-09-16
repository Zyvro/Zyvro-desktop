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

export type StoredMessage = {
  role: "user" | "assistant"
  text: string
  tools: string[]
  error?: string
}

export type Conversation = {
  id: string
  kind: AgentKind
  title: string
  // The CLI's own id for this thread, learned from its output stream. Null
  // until the first turn has run: there is nothing to resume before then.
  sessionId: string | null
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
