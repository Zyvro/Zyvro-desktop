// The desktop app is useless without the local engine, so packaging builds it
// rather than hoping someone remembered to.
//
// It builds per architecture, not just for this machine. An Intel installer
// carrying an arm64 engine opens a window that can do nothing, and the failure
// arrives on a user's machine rather than here.
//
//     node scripts/build-engine.mjs                  the host, for development
//     node scripts/build-engine.mjs darwin arm64     one specific target
//     node scripts/build-engine.mjs --all            every target a release needs
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const engine = path.resolve(here, "../../Zyvro-engine")

// The targets a release covers. Windows on arm64 is left out until someone
// asks: it doubles the Windows surface for a population that can run the x64
// build under emulation.
const RELEASE_TARGETS = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "windows", arch: "amd64" },
]

// Go and Electron disagree about what to call the same processor. The file name
// follows Electron, because electron-builder is what reads it.
const ELECTRON_ARCH = { amd64: "x64", arm64: "arm64" }

function normalizeOs(value) {
  if (value === "win" || value === "win32" || value === "windows") return "windows"
  if (value === "mac" || value === "darwin") return "darwin"
  return value
}

function normalizeArch(value) {
  if (value === "x64" || value === "amd64") return "amd64"
  if (value === "arm64" || value === "aarch64") return "arm64"
  return value
}

function stamp() {
  const read = (args, fallback) => {
    const result = spawnSync("git", args, { cwd: engine, encoding: "utf8" })
    return result.status === 0 ? result.stdout.trim() : fallback
  }
  return {
    version: read(["describe", "--tags", "--always", "--dirty"], "dev"),
    commit: read(["rev-parse", "--short", "HEAD"], "unknown"),
  }
}

function build({ os, arch }, marks) {
  const electronArch = ELECTRON_ARCH[arch] ?? arch
  const name = os === "windows" ? `zyvrod-windows-${electronArch}.exe` : `zyvrod-${os}-${electronArch}`
  const result = spawnSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-X main.Version=${marks.version} -X main.Commit=${marks.commit}`,
      "-o",
      path.join("bin", name),
      "./cmd/zyvrod",
    ],
    {
      cwd: engine,
      stdio: "inherit",
      env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: "0" },
    }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
  console.log(`  Zyvro-engine/bin/${name}  (${marks.version})`)
  return name
}

if (!existsSync(path.join(engine, "go.mod"))) {
  console.error(`Cannot find the engine at ${engine}. The desktop app expects it as a sibling folder.`)
  process.exit(1)
}

const args = process.argv.slice(2)
const marks = stamp()

if (args[0] === "--all") {
  for (const target of RELEASE_TARGETS) build(target, marks)
} else if (args.length >= 1) {
  const os = normalizeOs(args[0])
  // A named platform with no architecture means every architecture a release
  // ships for that platform, which is what packaging needs.
  const arches = args[1]
    ? [normalizeArch(args[1])]
    : RELEASE_TARGETS.filter((t) => t.os === os).map((t) => t.arch)
  if (arches.length === 0) {
    console.error(`No release target for platform "${args[0]}".`)
    process.exit(1)
  }
  for (const arch of arches) build({ os, arch }, marks)
} else {
  // No arguments: the host, which is what `npm run dev` wants.
  const os = normalizeOs(process.platform)
  const arch = normalizeArch(process.arch)
  const name = build({ os, arch }, marks)
  // Development resolves bin/zyvrod, so the host build keeps that name too.
  spawnSync("cp", [path.join("bin", name), path.join("bin", os === "windows" ? "zyvrod.exe" : "zyvrod")], {
    cwd: engine,
  })
}
