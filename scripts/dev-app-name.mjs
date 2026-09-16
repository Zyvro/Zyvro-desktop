// In development there is no bundle of our own: the app runs inside the
// Electron.app that npm installed, and macOS takes the name it shows from that
// bundle. So it says "Electron".
//
// Where macOS takes it from is the whole difficulty, and it is not one place.
//
//   - The menu bar reads CFBundleName out of the Info.plist.
//   - The Dock tile reads the name of the .app directory itself.
//
// app.setName() changes neither. It changes what app.getName() answers — paths,
// notifications — and nothing a person sees.
//
// The second one cost a day. The plist was rewritten, LaunchServices was asked
// to re-read the bundle, `lsappinfo` reported "Zyvro Studio", and the Dock went
// on saying "Electron" — because none of that is what the Dock reads. Tried and
// ruled out, in this order: rewriting CFBundleName and CFBundleDisplayName,
// re-registering with `lsregister -f`, giving the bundle its own
// CFBundleIdentifier, and renaming the executable inside it. The Dock changed
// on none of them. It changed when the directory was renamed.
//
// The lesson worth keeping is about the checking, not about macOS: `lsappinfo`
// was answering a question next to the one being asked, and it kept answering
// "Zyvro Studio" while the Dock said otherwise. What settles it is reading the
// Dock's own tile, which is what verify() does below.
//
// A packaged build is unaffected: electron-builder names both the directory and
// the plist, and this script is not part of packaging.
//
// It runs from `npm run dev` rather than only from postinstall, because an
// npm install restores the stock bundle and nobody would connect the name
// quietly reverting with having added a dependency last week.
//
//     node scripts/dev-app-name.mjs
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const NAME = "Zyvro Studio"
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

const electron = path.resolve(import.meta.dirname, "..", "node_modules/electron")
const dist = path.join(electron, "dist")
const wanted = path.join(dist, `${NAME}.app`)
const stock = path.join(dist, "Electron.app")

// Only macOS keeps the name in a bundle; Windows and Linux take it from the
// window and the menu we build ourselves, which already say the right thing.
if (process.platform !== "darwin" || !existsSync(dist)) process.exit(0)

const bundle = existsSync(wanted) ? wanted : stock
if (!existsSync(bundle)) process.exit(0)

const did = []

// 1. The directory, which is what the Dock shows.
//
// path.txt is how the electron package tells its callers where the binary is —
// electron-vite asks it every time — so it moves with the directory or nothing
// starts at all.
if (bundle === stock) {
  renameSync(stock, wanted)
  const pointer = path.join(electron, "path.txt")
  writeFileSync(pointer, readFileSync(pointer, "utf8").replace("Electron.app/", `${NAME}.app/`), "utf8")
  did.push("renamed the bundle directory")
}

// 2. The Info.plist, which is what the menu bar shows.
const plist = path.join(wanted, "Contents/Info.plist")
const plistBuddy = (...args) =>
  spawnSync("/usr/libexec/PlistBuddy", [...args, plist], { encoding: "utf8" })
const named = () => plistBuddy("-c", "Print :CFBundleName").stdout?.trim()

if (named() !== NAME) {
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    // Set fails when the key is absent, so add is the fallback rather than the
    // other way round: CFBundleName is always there, CFBundleDisplayName is not.
    const set = plistBuddy("-c", `Set :${key} ${NAME}`)
    if (set.status !== 0) plistBuddy("-c", `Add :${key} string ${NAME}`)
  }
  if (named() !== NAME) {
    console.error(`Could not rename the development Electron bundle (it still reads "${named()}").`)
    process.exit(1)
  }
  did.push("renamed it in the plist")
}

// 3. The icon on that same tile, which would otherwise stay Electron's atom.
// Compared by content rather than by timestamp: npm install restores the stock
// icon with a fresh mtime, which would read as newer than ours.
const ours = path.resolve(import.meta.dirname, "..", "resources/icon.icns")
const iconName = plistBuddy("-c", "Print :CFBundleIconFile").stdout?.trim()
if (ours && iconName) {
  const icon = path.join(wanted, "Contents/Resources", iconName.endsWith(".icns") ? iconName : `${iconName}.icns`)
  if (existsSync(ours) && existsSync(icon) && !readFileSync(icon).equals(readFileSync(ours))) {
    copyFileSync(ours, icon)
    did.push("gave it our icon")
  }
}

if (did.length === 0) process.exit(0)

// Handing the bundle back is not what fixed the Dock, but it is what keeps
// Finder, Spotlight and the switcher from showing the name the bundle had when
// they last looked at it.
spawnSync(LSREGISTER, ["-f", wanted], { encoding: "utf8" })

console.log(`Development app is "${NAME}": ${did.join(", ")}.`)
