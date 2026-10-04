import { build } from "esbuild"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import assert from "node:assert/strict"
const root = path.resolve(import.meta.dirname, "..")
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zyvro-conversations-"))
try {
  const mock = path.join(dir, "electron.cjs")
  await fs.writeFile(mock, `module.exports = { app: { getPath: () => ${JSON.stringify(dir)} } }`)
  await build({ entryPoints: [path.join(root, "src/main/conversations.ts")], outfile: path.join(dir, "conversations.cjs"), bundle: true, platform: "node", format: "cjs", alias: { electron: mock }, logLevel: "silent" })
  const store = createRequire(import.meta.url)(path.join(dir, "conversations.cjs"))
  const conversation = (id, title = id) => ({ id, title, kind: "claude", model: null, sessionId: `native-${id}`, messages: [{ role: "user", text: title }], updatedAt: "" })
  const project = path.join(dir, "project")
  const writes = await Promise.allSettled(Array.from({length: 12}, (_,i) => store.remember(project, conversation(`agent-${i}`))))
  assert.equal(writes.filter((r) => r.status === "rejected").length, 0, "parallel agent completions must not collide on the .partial file")
  let saved = await store.load(project)
  assert.equal(saved.length, 12, "parallel completions must not overwrite other conversations")
  assert.equal(new Set(saved.map((c) => c.id)).size, 12)
  await Promise.all([
    store.remember(project, conversation("agent-1", "Renamed session")),
    store.forget(project, "agent-2"),
    store.remember(project, conversation("agent-3", "Final response")),
  ])
  saved = await store.load(project)
  assert.equal(saved.length, 11)
  assert.equal(saved.find((c) => c.id === "agent-1").title, "Renamed session")
  assert.equal(saved.find((c) => c.id === "agent-3").title, "Final response")
  assert.equal(saved.some((c) => c.id === "agent-2"), false)
  await Promise.all([store.remember(project, conversation("deleted")), store.forget(project, "deleted")])
  assert.equal((await store.load(project)).some((c) => c.id === "deleted"), false, "delete after a queued save wins")

  // A storage error must not poison the queue for every later save.
  const folder = path.join(dir, "conversations")
  await fs.rename(folder, `${folder}-backup`)
  await fs.writeFile(folder, "not a directory")
  await assert.rejects(store.remember(project, conversation("retry")))
  await fs.rm(folder)
  await fs.rename(`${folder}-backup`, folder)
  await store.remember(project, conversation("retry"))
  assert.equal((await store.load(project)).some((c) => c.id === "retry"), true)
  assert.equal((await fs.readdir(folder)).some((name) => name.endsWith(".partial")), false)
  console.log("Conversations: concurrent saves, rename/delete ordering and recovery after write failure passed.")
} finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
