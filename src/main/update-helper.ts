import { spawn } from "node:child_process"
import fs from "node:fs"

/** Do not close the UI until the detached updater has actually initialized. */
export async function startUpdateHelper(command: string, args: string[], cwd: string, ready: string, log: string, timeoutMs = 15000): Promise<void> {
  const fd = fs.openSync(log, "a")
  const child = (() => {
    // Pas `detached` sous Windows : Node y lance alors le processus sans console
    // (DETACHED_PROCESS), et powershell.exe s'arrête aussitôt, code 0, sans
    // exécuter une ligne du script — « helper exited (0) », et la mise à jour
    // ne se posait jamais. Vu sur la machine Windows de la CI
    // (check-update-windows). Sans lui, il a sa console cachée, et Windows ne
    // tue pas un enfant quand son parent quitte : l'auxiliaire survit à Zyvro.
    try { return spawn(command, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", fd, fd], windowsHide: true }) }
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
