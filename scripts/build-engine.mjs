// The desktop app is useless without the local engine, so packaging builds it
// rather than hoping someone remembered to. Cross-compiling is deliberate: a
// Windows installer built on a Mac still needs a Windows binary inside it.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const backend = path.resolve(here, "../../Zyvro-engine")

const target = process.argv[2] ?? process.platform
const platform = target === "win" || target === "win32" ? "windows" : target === "mac" ? "darwin" : target
const binary = platform === "windows" ? "zyvrod.exe" : "zyvrod"

if (!existsSync(path.join(backend, "go.mod"))) {
  console.error(`Cannot find the engine at ${backend}. The desktop app expects it as a sibling folder.`)
  process.exit(1)
}

// The engine reports its own version to the desktop app, which compares it
// against the release channel. That only works if the number is stamped in at
// build time: a binary carrying the "dev" default is one that did not go
// through this script, and saying so is more useful than guessing a version.
// git failing is not a build failure — it is a tarball, or a CI checkout
// without history — so each value falls back to the same default the Go source
// declares.
const gitOutput = (args, fallback) => {
  const r = spawnSync("git", args, { cwd: backend, encoding: "utf8" })
  const value = r.status === 0 ? r.stdout.trim() : ""
  return value || fallback
}
const version = gitOutput(["describe", "--tags", "--always", "--dirty"], "dev")
const commit = gitOutput(["rev-parse", "--short", "HEAD"], "unknown")
const ldflags = `-X main.Version=${version} -X main.Commit=${commit}`

const env = { ...process.env, GOOS: platform, CGO_ENABLED: "0" }
const result = spawnSync("go", ["build", "-trimpath", "-ldflags", ldflags, "-o", path.join("bin", binary), "./cmd/zyvrod"], {
  cwd: backend,
  stdio: "inherit",
  env,
})

if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Built the local engine: Zyvro-engine/bin/${binary} (${version}, ${commit})`)
