// In development there is no bundle of our own: the app runs inside the
// Electron.app that npm installed, and macOS reads the name in the Dock, the
// menu bar, the app switcher and the Force Quit list out of that bundle. So it
// says "Electron".
//
// app.setName() does not fix it. It changes what app.getName() answers — paths,
// notifications — but the name macOS shows comes from CFBundleName in the
// running bundle, which Electron never rewrites.
//
// The Dock tile also carries Electron's atom in development, and the icon is
// replaced here for the same reason and in the same breath: it is the same
// tile, and fixing only the name leaves it half wrong.
//
// Rewriting the file is only half of it, and the half that is easy to mistake
// for the whole. macOS does not read Info.plist when it draws the Dock: it
// draws what LaunchServices recorded the last time it looked at the bundle, and
// `npm install` restores the stock bundle and gets it recorded as "Electron"
// before this script ever runs. The plist said "Zyvro Studio" for a day while
// the Dock kept saying "Electron" — the worst shape a bug can take, because the
// file you would open to diagnose it reads correct.
//
// Hence two states to check, not one, and no early exit on the first: a correct
// plist with a stale registration is the actual failure, and the version of
// this script that returned as soon as the plist looked right is what let it
// stand.
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
import { copyFileSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"

const NAME = "Zyvro Studio"
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

const bundle = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules/electron/dist/Electron.app"
)
const plist = path.join(bundle, "Contents/Info.plist")

// The same Dock tile carries the icon, and in development it is Electron's
// atom. Ours already exists — it is what electron-builder puts on a packaged
// build — so the tile can be right in development too rather than half right.
const ours = path.resolve(import.meta.dirname, "..", "resources/icon.icns")

// Only macOS keeps the name in a bundle; Windows and Linux take it from the
// window and the menu we build ourselves, which already say the right thing.
if (process.platform !== "darwin" || !existsSync(plist)) process.exit(0)

const plistBuddy = (...args) =>
  spawnSync("/usr/libexec/PlistBuddy", [...args, plist], { encoding: "utf8" })

const inPlist = () => plistBuddy("-c", "Print :CFBundleName").stdout?.trim()

// What macOS will actually show. The dump is large and the bundle's block is
// the few lines after its path, so only that slice is searched.
function asRegistered() {
  const dump = spawnSync(LSREGISTER, ["-dump"], { encoding: "utf8", maxBuffer: 512 << 20 }).stdout || ""
  const at = dump.indexOf(`${bundle} (0x`)
  if (at === -1) return null // never registered; launching it will register it correctly
  return /^\s*displayName:\s*(.+)$/m.exec(dump.slice(at, at + 2000))?.[1]?.trim() ?? null
}

// The icon file the bundle points at, whatever it is called.
const iconFile = () => {
  const named = plistBuddy("-c", "Print :CFBundleIconFile").stdout?.trim()
  if (!named) return null
  const file = named.endsWith(".icns") ? named : `${named}.icns`
  return path.join(bundle, "Contents/Resources", file)
}

const wasNamed = inPlist()
const wasShown = asRegistered()

// Compared by content rather than by timestamp: npm install restores the stock
// icon with a fresh mtime, which would read as newer than ours.
let iconReplaced = false
const icon = iconFile()
if (existsSync(ours) && icon && existsSync(icon)) {
  if (!readFileSync(icon).equals(readFileSync(ours))) {
    copyFileSync(ours, icon)
    iconReplaced = true
  }
}

if (wasNamed !== NAME) {
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    // Set fails when the key is absent, so add is the fallback rather than the
    // other way round: CFBundleName is always there, CFBundleDisplayName is not.
    const set = plistBuddy("-c", `Set :${key} ${NAME}`)
    if (set.status !== 0) plistBuddy("-c", `Add :${key} string ${NAME}`)
  }
  if (inPlist() !== NAME) {
    console.error(`Could not rename the development Electron bundle (it still reads "${inPlist()}").`)
    process.exit(1)
  }
}

if (wasShown === NAME && wasNamed === NAME && !iconReplaced) {
  process.exit(0) // everything already agrees; nothing to do and nothing to say
}

// -f re-reads the bundle and replaces what was recorded for it. Without it the
// Dock keeps the cached name for as long as the registration survives, which
// is indefinitely.
const registered = spawnSync(LSREGISTER, ["-f", bundle], { encoding: "utf8" })
if (registered.status !== 0) {
  console.error(`Renamed the bundle, but LaunchServices refused to re-read it; the Dock may still say "${wasShown}".`)
  process.exit(1)
}

const nowShown = asRegistered()
if (nowShown !== null && nowShown !== NAME) {
  console.error(`LaunchServices still calls this bundle "${nowShown}", so the Dock will too.`)
  process.exit(1)
}

const changed = [
  wasNamed !== NAME && "renamed the bundle",
  wasShown !== NAME && `told LaunchServices (it said "${wasShown ?? "nothing yet"}")`,
  iconReplaced && "gave it our icon",
].filter(Boolean)
console.log(`Development app is "${NAME}" in the Dock: ${changed.join(", ")}.`)
