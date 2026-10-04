import { build } from "esbuild"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
const root = path.resolve(import.meta.dirname, "..")
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zyvro-download-"))
try {
  const mock = path.join(dir, "electron.cjs")
  await fs.writeFile(mock, `module.exports = { app: { getPath: () => ${JSON.stringify(dir)} }, net: { fetch: (...args) => globalThis.updateFetch(...args) }, shell: {} }`)
  await build({ entryPoints: [path.join(root, "src/main/updater.ts")], outfile: path.join(dir, "updater.cjs"), bundle: true, format: "cjs", platform: "node", alias: { electron: mock }, logLevel: "silent" })
  const { downloadUpdate, installUpdate } = createRequire(import.meta.url)(path.join(dir, "updater.cjs"))
  const data = "fixture update package"
  const info = { kind: "patch", latest: "9.9.9", asset: { name: "update.zip", url: "https://example.invalid/update", size: data.length, sha256: createHash("sha256").update(data).digest("hex") } }
  const progress = []
  const target = { isDestroyed: () => false, send: (_event, value) => progress.push(value) }
  globalThis.updateFetch = async () => new Response(data)
  const downloaded = await downloadUpdate(info, target)
  assert.equal(downloaded.verified, true)
  assert.equal(await fs.readFile(downloaded.file, "utf8"), data)
  assert.equal(progress.at(-1).received, data.length)
  await assert.rejects(downloadUpdate({ ...info, asset: { ...info.asset, sha256: "0".repeat(64) } }, target), /does not match/)
  await assert.rejects(fs.access(downloaded.file))
  globalThis.updateFetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); setTimeout(() => controller.error(new Error("network interrupted")), 10) } }))
  await assert.rejects(downloadUpdate(info, target), /network interrupted/)
  await assert.rejects(fs.access(downloaded.file), "failed downloads must not remain installable")
  // Simulate a filesystem open error, after download cleanup has run.
  // The old WriteStream had no error listener and would crash the process.
  globalThis.updateFetch = async () => { await fs.mkdir(downloaded.file); return new Response(data) }
  await assert.rejects(downloadUpdate(info, target), /EISDIR|EPERM|EACCES/)
  await fs.rm(downloaded.file, { recursive: true, force: true })
  let finishDownload
  globalThis.updateFetch = () => new Promise((resolve) => { finishDownload = resolve })
  const activeDownload = downloadUpdate(info, target)
  while (!finishDownload) await new Promise((resolve) => setTimeout(resolve, 1))
  await assert.rejects(downloadUpdate(info, target), /already downloading/)
  await assert.rejects(installUpdate(downloaded.file, info), /download to finish/)
  finishDownload(new Response(data))
  await activeDownload
  delete globalThis.updateFetch
  console.log("Update download: streaming, checksum, network interruption and file-write failure passed.")
} finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
