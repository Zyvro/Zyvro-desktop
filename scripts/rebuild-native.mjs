// node-pty is the only native dependency, and it is worth the trouble: without
// a real PTY, `claude` and `codex` detect a pipe and drop their interactive
// behaviour, which is exactly what this app is for.
//
// On macOS the build fails against the Xcode SDK that `xcrun` selects by
// default (libc++ header search order), while the Command Line Tools SDK
// compiles it cleanly. So: try the default, and on failure retry pinned to the
// newest Command Line Tools SDK before giving up.
import { spawnSync } from "node:child_process"
import { readdirSync, existsSync } from "node:fs"
import path from "node:path"

const CLT_SDK_DIR = "/Library/Developer/CommandLineTools/SDKs"

function rebuild(env, label) {
  process.stdout.write(`\nRebuilding node-pty (${label})...\n`)
  const result = spawnSync("npx", ["electron-rebuild", "-f", "-w", "node-pty"], {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  })
  return result.status === 0
}

// newestCltSdk prefers a specific versioned SDK over the unversioned symlink,
// which on some machines points back at the very SDK that just failed.
function newestCltSdk() {
  if (!existsSync(CLT_SDK_DIR)) return null
  const versioned = readdirSync(CLT_SDK_DIR)
    .filter((name) => /^MacOSX\d+(\.\d+)?\.sdk$/.test(name))
    .sort((a, b) => {
      const num = (s) => parseFloat(s.replace(/^MacOSX|\.sdk$/g, "")) || 0
      return num(a) - num(b)
    })
  if (versioned.length === 0) return null
  return path.join(CLT_SDK_DIR, versioned[versioned.length - 1])
}

if (rebuild({}, "default toolchain")) process.exit(0)

if (process.platform === "darwin") {
  const sdk = newestCltSdk()
  if (sdk && rebuild({ SDKROOT: sdk }, `Command Line Tools SDK at ${sdk}`)) process.exit(0)
}

process.stdout.write(
  "\nnode-pty could not be built. The app still runs: the terminal falls back to\n" +
    "a `script`-allocated PTY on macOS and Linux, and to pipes on Windows.\n"
)
process.exit(0)
