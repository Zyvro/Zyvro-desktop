import { build } from "esbuild"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import assert from "node:assert/strict"
const root = path.resolve(import.meta.dirname, "..")
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "zyvro helper ")))
const tick = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  await build({ entryPoints: [path.join(root, "src/main/update-helper.ts")], outfile: path.join(dir, "helper.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
  const { startUpdateHelper } = createRequire(import.meta.url)(path.join(dir, "helper.cjs"))
  const ready = path.join(dir, "ready")
  const log = path.join(dir, "bootstrap.log")
  const marker = path.join(dir, "cwd")
  const stop = path.join(dir, "stop")
  const script = path.join(dir, "fake helper.cjs")
  fs.writeFileSync(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, process.cwd()); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const timer = setInterval(() => { if(fs.existsSync(${JSON.stringify(stop)})) { clearInterval(timer); } }, 20); setTimeout(() => process.exit(0), 10000).unref()`)
  await startUpdateHelper(process.execPath, [script], dir, ready, log)
  assert.equal(fs.readFileSync(marker, "utf8"), dir, "helper must not inherit a cwd inside installed resources")
  fs.writeFileSync(stop, "stop")
  fs.unlinkSync(ready)
  await tick(100)
  await assert.rejects(startUpdateHelper(path.join(dir, "missing.exe"), [], dir, ready, log), /Could not start the updater/)
  await assert.rejects(startUpdateHelper(process.execPath, ["-e", "console.error('policy denied'); process.exit(7)"], dir, ready, log), /helper exited \(7\)/)
  assert.match(fs.readFileSync(log, "utf8"), /policy denied/, "startup error must remain diagnosable")
  await assert.rejects(startUpdateHelper(process.execPath, ["-e", "setInterval(() => {}, 1000)"], dir, ready, log, 100), /did not signal readiness/)
  await tick(100)
  // Run the real install orchestrator with a controllable helper and Electron
  // lifecycle. No quit on bootstrap failure; no commit on canceled quit.
  const updates = path.join(dir, "updates")
  fs.mkdirSync(updates)
  const installer = path.join(updates, "Zyvro Setup.exe")
  fs.writeFileSync(installer, "fixture")
  const mockElectron = path.join(dir, "electron.cjs")
  const mockHelper = path.join(dir, "mock-helper.ts")
  fs.writeFileSync(mockElectron, `const {EventEmitter} = require('node:events'); const app = new EventEmitter(); app.getPath = () => ${JSON.stringify(dir)}; app.quits = 0; app.quit = () => app.quits++; module.exports = { app, net: {}, shell: {} }`)
  fs.writeFileSync(mockHelper, `export const startUpdateHelper = (...args) => globalThis.updateBootstrap(...args)`)
  await build({ entryPoints: [path.join(root, "src/main/updater.ts")], outfile: path.join(dir, "updater.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent",
    external: [mockElectron],
    alias: { electron: mockElectron },
    plugins: [{ name: "helper", setup(b) { b.onResolve({ filter: /^\.\/update-helper$/ }, () => ({ path: mockHelper })) } }],
    define: { "process.platform": '"win32"' },
  })
  const req = createRequire(import.meta.url)
  const { app } = req(mockElectron)
  const updater = req(path.join(dir, "updater.cjs"))
  const info = { kind: "full", latest: "9.9.9" }
  globalThis.updateBootstrap = async () => { throw new Error("blocked helper") }
  await assert.rejects(updater.installUpdate(installer, info), /blocked helper/)
  assert.equal(app.quits, 0)
  assert.equal(app.listenerCount("will-quit"), 0)
  let complete
  let launchArgs
  globalThis.updateBootstrap = (...args) => { launchArgs = args; return new Promise((r) => { complete = r }) }
  const pending = updater.installUpdate(installer, info)
  while (!complete) await tick(10)
  assert.equal(app.quits, 0, "must await readiness before asking windows to close")
  await assert.rejects(updater.installUpdate(installer, info), /already being prepared/)
  await assert.rejects(updater.downloadUpdate(info, {}), /already prepared/)
  assert.equal(app.quits, 0, "a second window must not quit or replace the first helper")
  assert.equal(launchArgs[2], updates)
  assert.ok(launchArgs[1].includes("-Installer"))
  complete()
  assert.equal(await pending, "quitting")
  assert.equal(app.quits, 1)
  const commit = path.join(updates, "apply.commit")
  assert.equal(fs.existsSync(commit), false, "canceled quit must not apply update")
  await updater.installUpdate(installer, info)
  assert.equal(app.listenerCount("will-quit"), 1, "retry closing must not start a second helper")
  app.emit("will-quit")
  assert.equal(fs.readFileSync(commit, "utf8"), "quit")
  const mockSettings = path.join(dir, "settings.ts")
  fs.writeFileSync(mockSettings, `export const getSettings = () => ({checkForUpdates: false})`)
  await build({ entryPoints: [path.join(root, "src/renderer/state/update.ts")], outfile: path.join(dir, "update-state.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent",
    plugins: [{ name: "settings", setup(b) { b.onResolve({ filter: /^~\/state\/settings$/ }, () => ({path: mockSettings})) } }],
    banner: { js: "var window = globalThis.updateWindow; var setTimeout = () => 0; var setInterval = () => 0;" },
  })
  let installs = 0, checks = 0, finishInstall
  globalThis.updateWindow = { zyvro: { update: {
    check: async () => { checks++; return info },
    download: async () => ({ verified: true }),
    onProgress: () => () => {}, onCheckRequested: () => {},
    install: () => { installs++; return new Promise((resolve) => { finishInstall = resolve }) },
  } } }
  const state = req(path.join(dir, "update-state.cjs"))
  await state.checkForUpdate(false)
  await state.downloadUpdate()
  const installing = state.installUpdate()
  assert.equal(state.updateState().phase, "installing")
  assert.equal(await state.installUpdate(), null)
  await state.checkForUpdate(true)
  assert.equal(installs, 1)
  assert.equal(checks, 1)
  finishInstall("quitting")
  await installing
  assert.equal(state.updateState().phase, "ready", "a canceled window close must leave Restart available")
  globalThis.updateWindow.zyvro.update.install = async () => { throw new Error("updater unavailable") }
  assert.equal(await state.installUpdate(), null)
  assert.equal(state.updateState().phase, "error")
  assert.match(state.updateState().message, /updater unavailable/)
  delete globalThis.updateWindow
  delete globalThis.updateBootstrap
  console.log("Updater: readiness, missing executable, early exit, timeout, failed and canceled quits passed.")
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
