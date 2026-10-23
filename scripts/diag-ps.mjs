// Diagnostic temporaire : quelles options de lancement laissent PowerShell exécuter un script.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zyvro diag "))
const script = path.join(dir, "s.ps1")
fs.writeFileSync(script, "\uFEFFparam([string]$Ready)\nSet-Content -LiteralPath $Ready -Value 'ready'\nWrite-Output 'ran'\nStart-Sleep -Seconds 3\n", "utf8")
const variants = [
  ["detached+hidden+windowsHide", { detached: true, windowsHide: true }, true],
  ["detached+windowsHide (no -WindowStyle)", { detached: true, windowsHide: true }, false],
  ["detached only + hidden", { detached: true }, true],
  ["not detached + hidden + windowsHide", { windowsHide: true }, true],
  ["not detached, no hidden", { windowsHide: true }, false],
]
for (const [name, opts, hidden] of variants) {
  const ready = path.join(dir, name.replace(/\W+/g, "_") + ".ready")
  const log = ready + ".log"
  const fd = fs.openSync(log, "a")
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", ...(hidden ? ["-WindowStyle", "Hidden"] : []), "-File", script, "-Ready", ready]
  const t0 = Date.now()
  const child = spawn(ps, args, { cwd: dir, stdio: ["ignore", fd, fd], ...opts })
  fs.closeSync(fd)
  let exit = null
  child.on("exit", (c) => (exit = c))
  let t = null
  while (Date.now() - t0 < 20000) {
    if (t === null && fs.existsSync(ready)) t = Date.now() - t0
    if (exit !== null) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (t === null && fs.existsSync(ready)) t = Date.now() - t0
  console.log(`${name}: ready=${t === null ? "NO" : t + "ms"} exit=${exit} out=${JSON.stringify(fs.readFileSync(log, "utf8").slice(0, 300))}`)
  try { child.kill() } catch {}
}
