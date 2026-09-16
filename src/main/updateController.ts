import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { BrowserWindow } from "electron"
import {
  CHECK_INTERVAL,
  downloadEngine,
  fetchManifest,
  installedEngine,
  platformKey,
  compareVersions,
  type EngineManifest,
  type UpdateState,
} from "./engineUpdate"

const run = promisify(execFile)

// The update controller owns one piece of state for the whole app: whether a
// newer engine exists, and how far along an install is. It never installs
// anything on its own. The user is told, and the offer stays visible until they
// act on it, which is the only reason an automatic check is acceptable for a
// binary that runs with their privileges.

export class UpdateController {
  private state: UpdateState = { status: "idle" }
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  private resolveCurrent: () => Promise<string>

  constructor(currentVersion: () => Promise<string>) {
    this.resolveCurrent = currentVersion
  }

  snapshot(): UpdateState {
    return this.state
  }

  private set(next: UpdateState): void {
    this.state = next
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("engine-update:state", next)
    }
  }

  // start schedules the periodic check. The first one is delayed: a check
  // racing the first window means a dialog before the app has drawn anything.
  start(): void {
    if (this.timer) return
    setTimeout(() => void this.check(), 20_000)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async check(): Promise<UpdateState> {
    if (this.inFlight) return this.state
    const platform = platformKey()
    if (!platform) {
      this.set({ status: "failed", message: "This platform has no published engine.", checkedAt: new Date().toISOString() })
      return this.state
    }

    this.inFlight = true
    this.set({ status: "checking" })
    try {
      const current = await this.resolveCurrent()
      const manifest = await fetchManifest(platform)
      const checkedAt = new Date().toISOString()

      // Strictly newer, never merely different. A manifest replayed from an
      // older release must not be able to walk a user backwards onto a version
      // whose bugs are known.
      if (compareVersions(manifest.version, current) > 0) {
        this.set({ status: "available", current, manifest, checkedAt })
      } else {
        this.set({ status: "current", version: current, checkedAt })
      }
    } catch (err) {
      this.set({ status: "failed", message: (err as Error).message, checkedAt: new Date().toISOString() })
    } finally {
      this.inFlight = false
    }
    return this.state
  }

  // install runs only after the user has said yes. It re-reads the manifest
  // from the state rather than taking one from the renderer, so a compromised
  // window cannot hand the main process an artifact of its choosing.
  async install(): Promise<UpdateState> {
    if (this.state.status !== "available") return this.state
    const manifest: EngineManifest = this.state.manifest
    this.set({ status: "downloading", manifest, receivedBytes: 0, totalBytes: manifest.size })
    try {
      await downloadEngine(manifest, (received, total) => {
        this.set({ status: "downloading", manifest, receivedBytes: received, totalBytes: total })
      })
      this.set({ status: "installed", version: manifest.version, restartRequired: true })
    } catch (err) {
      this.set({ status: "failed", message: (err as Error).message, checkedAt: new Date().toISOString() })
    }
    return this.state
  }

  // dismiss puts the offer back to a quiet state without forgetting it: the
  // next check finds the same release again, and the status bar keeps showing
  // it, which is what the user asked for.
  dismiss(): void {
    if (this.state.status === "available") {
      this.set({ status: "current", version: this.state.current, checkedAt: this.state.checkedAt })
    }
  }
}

// currentEngineVersion asks whichever engine this app would actually launch.
// Reading the directory name of an installed engine would be cheaper and would
// also believe a directory someone renamed.
export async function currentEngineVersion(bundledPath: () => string): Promise<string> {
  const installed = await installedEngine()
  const binary = installed?.path ?? bundledPath()
  try {
    const { stdout } = await run(binary, ["--version"], { timeout: 5000 })
    // "zyvrod 1.4.0 darwin/arm64 abc1234"
    const parts = stdout.trim().split(/\s+/)
    return parts[1] || "dev"
  } catch {
    // An engine too old to know --version is, by definition, older than
    // anything the channel will offer.
    return "0.0.0"
  }
}
