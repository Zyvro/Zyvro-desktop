// Cuts a release of Zyvro Studio.
//
// It exists so a release is one command with one outcome. The alternative is a
// list of steps in a document, which drifts from what anyone actually runs and
// produces builds nobody can reproduce.
//
//     npm run release -- 0.1.0-alpha.1
//
// Publishing is NOT part of this. The artifacts are built and hashed, and a
// human looks at them before they become public. See RELEASE.md.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const ENGINE = path.resolve(ROOT, "../Zyvro-engine")

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run release -- <version>   e.g. 0.1.0-alpha.1")
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options })
  if (result.status !== 0) {
    console.error(`\nFailed: ${command} ${args.join(" ")}`)
    process.exit(result.status ?? 1)
  }
}

function capture(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : ""
}

// A release built from uncommitted changes is a release nobody can reproduce,
// including whoever has to work out later what went into it.
for (const [label, dir] of [["Zyvro-desktop", ROOT], ["Zyvro-engine", ENGINE]]) {
  const dirty = capture("git", ["status", "--porcelain"], dir)
  if (dirty) {
    console.error(`${label} has uncommitted changes. Commit or stash them first:\n${dirty}`)
    process.exit(1)
  }
}

console.log(`\n=== Zyvro Studio ${version} ===`)
console.log(`desktop  ${capture("git", ["rev-parse", "--short", "HEAD"], ROOT)}`)
console.log(`engine   ${capture("git", ["rev-parse", "--short", "HEAD"], ENGINE)}`)

const manifestPath = path.join(ROOT, "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
manifest.version = version
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

// Each installer carries the engine for its own platform, so all three are
// built before any packaging starts.
console.log("\n--- engine ---")
for (const platform of ["darwin", "windows"]) {
  run("node", ["scripts/build-engine.mjs", platform])
}

console.log("\n--- renderer and main ---")
run("npx", ["electron-vite", "build"])

console.log("\n--- installers ---")
// macOS and Windows want different engine binaries under the same name in the
// config, which is why ZYVROD_BIN is set per pass rather than once.
run("npx", ["electron-builder", "--mac", "dmg", "--arm64", "--x64"], {
  env: { ...process.env, ZYVROD_BIN: "zyvrod" },
})
run("npx", ["electron-builder", "--win", "nsis", "--x64"], {
  env: { ...process.env, ZYVROD_BIN: "zyvrod.exe" },
})

// The hashes are the only integrity check an unsigned download has. They belong
// in the release notes, so they are printed in a form that can be pasted there.
console.log("\n--- artifacts ---")
const dist = path.join(ROOT, "dist")
const artifacts = readdirSync(dist)
  .filter((name) => /\.(dmg|exe)$/.test(name))
  .sort()

if (artifacts.length === 0) {
  console.error("No installer was produced. Something above failed quietly.")
  process.exit(1)
}

console.log("\n| File | Size | SHA-256 |")
console.log("|---|---|---|")
for (const name of artifacts) {
  const file = path.join(dist, name)
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex")
  const mb = (statSync(file).size / (1024 * 1024)).toFixed(1)
  console.log(`| \`${name}\` | ${mb} MB | \`${digest}\` |`)
}

console.log(`\nBuilt. Nothing is published yet; see RELEASE.md for the gh command.`)
