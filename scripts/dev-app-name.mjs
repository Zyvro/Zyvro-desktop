// In development there is no bundle of our own: the app runs inside the
// Electron.app that npm installed, and macOS reads the name in the menu bar,
// the app switcher and the Force Quit list straight out of that bundle's
// Info.plist. So it says "Electron".
//
// app.setName() does not fix it. It changes what app.getName() answers — paths,
// notifications — but the menu bar title comes from CFBundleName in the running
// bundle, which Electron never rewrites. The only place to change it is here.
//
// A packaged build is unaffected: electron-builder writes "Zyvro Studio" into
// the bundle it makes, and this script is not part of packaging.
//
// It runs from `npm run dev` rather than only from postinstall, because an
// npm install restores the stock bundle and nobody would connect the name
// quietly reverting with having added a dependency last week.
//
//     node scripts/dev-app-name.mjs
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const NAME = "Zyvro Studio"
const plist = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules/electron/dist/Electron.app/Contents/Info.plist"
)

// Only macOS keeps the name in a bundle; Windows and Linux take it from the
// window and the menu we build ourselves, which already say the right thing.
if (process.platform !== "darwin" || !existsSync(plist)) process.exit(0)

function plistBuddy(...args) {
  return spawnSync("/usr/libexec/PlistBuddy", [...args, plist], { encoding: "utf8" })
}

const current = plistBuddy("-c", "Print :CFBundleName").stdout?.trim()
if (current === NAME) process.exit(0)

for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  // Set fails when the key is absent, so add is the fallback rather than the
  // other way round: CFBundleName is always there, CFBundleDisplayName is not.
  const set = plistBuddy("-c", `Set :${key} ${NAME}`)
  if (set.status !== 0) plistBuddy("-c", `Add :${key} string ${NAME}`)
}

const now = plistBuddy("-c", "Print :CFBundleName").stdout?.trim()
if (now !== NAME) {
  console.error(`Could not rename the development Electron bundle (it still reads "${now}").`)
  process.exit(1)
}
console.log(`Development app named "${NAME}" (was "${current}").`)
