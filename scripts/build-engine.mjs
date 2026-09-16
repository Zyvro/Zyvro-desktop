// The desktop app is useless without the local engine, so packaging builds it
// rather than hoping someone remembered to. Cross-compiling is deliberate: a
// Windows installer built on a Mac still needs a Windows binary inside it.
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const backend = path.resolve(here, "../../Zyvro-backend")

const target = process.argv[2] ?? process.platform
const platform = target === "win" || target === "win32" ? "windows" : target === "mac" ? "darwin" : target
const binary = platform === "windows" ? "zyvrod.exe" : "zyvrod"

if (!existsSync(path.join(backend, "go.mod"))) {
  console.error(`Cannot find the backend at ${backend}. The desktop app expects it as a sibling folder.`)
  process.exit(1)
}

const env = { ...process.env, GOOS: platform, CGO_ENABLED: "0" }
const result = spawnSync("go", ["build", "-trimpath", "-o", path.join("bin", binary), "./cmd/zyvrod"], {
  cwd: backend,
  stdio: "inherit",
  env,
})

if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Built the local engine: Zyvro-backend/bin/${binary}`)
