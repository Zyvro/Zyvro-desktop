// node-pty does not compile against the SDK that `xcrun` selects by default on
// this machine: libc++ finds the wrong <stddef.h> and the build stops. The
// Command Line Tools SDK compiles it cleanly.
//
// Two places need this: `npm install`, through scripts/rebuild-native.mjs, and
// packaging, because electron-builder runs its own native rebuild per
// architecture. One copy, so the two cannot drift.
import { readdirSync, existsSync } from "node:fs"
import path from "node:path"

const CLT_SDK_DIR = "/Library/Developer/CommandLineTools/SDKs"

// newestCltSdk prefers a specific versioned SDK over the unversioned symlink,
// which on some machines points back at the very SDK that fails.
export function newestCltSdk() {
  if (process.platform !== "darwin" || !existsSync(CLT_SDK_DIR)) return null
  const versioned = readdirSync(CLT_SDK_DIR)
    .filter((name) => /^MacOSX\d+(\.\d+)?\.sdk$/.test(name))
    .sort((a, b) => {
      const num = (s) => parseFloat(s.replace(/^MacOSX|\.sdk$/g, "")) || 0
      return num(a) - num(b)
    })
  if (versioned.length === 0) return null
  return path.join(CLT_SDK_DIR, versioned[versioned.length - 1])
}

// nativeBuildEnv returns the environment a native rebuild needs. It leaves the
// environment alone where the default toolchain already works.
export function nativeBuildEnv(base = process.env) {
  const sdk = newestCltSdk()
  return sdk ? { ...base, SDKROOT: sdk } : { ...base }
}
