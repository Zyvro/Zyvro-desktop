// node-pty is the only native dependency, and it is worth the trouble: without
// a real PTY, `claude` and `codex` detect a pipe and drop their interactive
// behaviour, which is exactly what this app is for.
//
// On macOS the build fails against the SDK `xcrun` selects by default (libc++
// header search order), while the Command Line Tools SDK compiles it cleanly.
// So: try the default, and on failure retry pinned to that SDK before giving up.
import { spawnSync } from "node:child_process"
import { newestCltSdk } from "./mac-sdk.mjs"

function rebuild(env, label) {
  process.stdout.write(`\nRebuilding node-pty (${label})...\n`)
  const result = spawnSync("npx", ["electron-rebuild", "-f", "-w", "node-pty"], {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  })
  return result.status === 0
}

if (rebuild({}, "default toolchain")) process.exit(0)

const sdk = newestCltSdk()
if (sdk && rebuild({ SDKROOT: sdk }, `Command Line Tools SDK at ${sdk}`)) process.exit(0)

process.stdout.write(
  "\nnode-pty could not be built. The app still runs: the terminal falls back to\n" +
    "a `script`-allocated PTY on macOS and Linux, and to pipes on Windows.\n"
)
process.exit(0)
