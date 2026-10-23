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
    // Un lanceur qui s'en va une fois l'auxiliaire prêt (windowsLaunch) : sa fin
    // n'est une erreur que si l'auxiliaire ne s'est pas dit prêt.
    child.once("exit", (code) => (fs.existsSync(ready) ? finish() : finish(new Error(`helper exited (${code})`))))
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

/**
 * windowsLaunch : comment lancer l'auxiliaire PowerShell pour qu'il survive à
 * l'application, sous Windows.
 *
 * Deux pièges, vus tous les deux sur la machine Windows de la CI
 * (check-update-windows) :
 * - lancé `detached`, Node le crée sans console (DETACHED_PROCESS), et
 *   powershell.exe s'arrête aussitôt, code 0, sans exécuter le script —
 *   « helper exited (0) » ;
 * - lancé normalement, Node le range dans un job Windows qui tue ses enfants
 *   quand l'application quitte : l'auxiliaire mourait avant d'avoir posé la
 *   mise à jour.
 *
 * Donc un lanceur, enfant normal de l'application : un PowerShell qui démarre
 * le vrai par `Start-Process` (avec sa console, cachée, et hors du job — Node
 * permet à ses petits-enfants d'en sortir), attend qu'il se dise prêt, et s'en va.
 */
export function windowsLaunch(powershell: string, scriptArgs: string[], ready: string): { command: string; args: string[] } {
  const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
  // Les chemins Windows ne contiennent pas de guillemet double : chaque argument
  // entre guillemets suffit pour la ligne de commande du vrai auxiliaire.
  const line = scriptArgs.map((a) => `"${a}"`).join(" ")
  const lanceur = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath ${q(powershell)} -ArgumentList ${q(line)} -WindowStyle Hidden -PassThru`,
    "$deadline = (Get-Date).AddSeconds(14)",
    `while (-not (Test-Path -LiteralPath ${q(ready)})) {`,
    "  if ($p.HasExited) { Write-Output \"updater exited ($($p.ExitCode)) before it was ready\"; exit 2 }",
    "  if ((Get-Date) -gt $deadline) { Write-Output 'updater did not signal readiness'; exit 3 }",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "exit 0",
  ].join("\n")
  const encoded = Buffer.from(lanceur, "utf16le").toString("base64")
  return { command: powershell, args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded] }
}
