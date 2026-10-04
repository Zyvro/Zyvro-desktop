import { spawn } from "node:child_process"
import fs from "node:fs"

/** Do not close the UI until the detached updater has actually initialized. */
export async function startUpdateHelper(command: string, args: string[], cwd: string, ready: string, log: string, timeoutMs = 15000): Promise<void> {
  const fd = fs.openSync(log, "a")
  const child = (() => {
    try { return spawn(command, args, { cwd, detached: true, stdio: ["ignore", fd, fd], windowsHide: true }) }
    finally { fs.closeSync(fd) }
  })()
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) { child.kill(); reject(new Error(`Could not start the updater: ${err.message}. See ${log}`)) }
      else { child.unref(); resolve() }
    }
    // Keep the error listener after readiness: a late OS error must not crash
    // Electron while it is closing its windows.
    child.on("error", (err) => finish(err))
    child.once("exit", (code) => finish(new Error(`helper exited (${code})`)))
    const deadline = Date.now() + timeoutMs
    const poll = (): void => {
      if (settled) return
      if (fs.existsSync(ready)) return finish()
      if (Date.now() >= deadline) return finish(new Error("helper did not signal readiness"))
      timer = setTimeout(poll, 50)
    }
    poll()
  })
}
