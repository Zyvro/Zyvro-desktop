// BUILT_IN_KINDS in Zyvro-frontend is a hand-written mirror of what the engine
// implements. The web app needs it static: it draws a palette before it has
// asked anything, and there is no daemon on the other end to ask.
//
// A mirror nobody checks drifts. Add a node to the engine, forget the list, and
// the web palette simply does not have it — no error anywhere, just a node the
// desktop offers and the browser does not. So this compares the two, here,
// because this repo is the one place that has both: it compiles the frontend's
// source and it builds the engine.
//
//     node scripts/check-node-kinds.mjs
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const engineDir = path.resolve(ROOT, "../Zyvro-engine")
const nodesTs = path.resolve(ROOT, "../Zyvro-frontend/src/lib/nodes.ts")

for (const [what, where] of [["the engine", engineDir], ["the frontend's nodes.ts", nodesTs]]) {
  if (!existsSync(where)) {
    console.log(`skipped: ${what} is not next to this repo (${where})`)
    process.exit(0)
  }
}

// What the engine says. Asked of the engine rather than parsed out of its Go,
// so a node that moves between a switch case and a Lua file does not register
// as a change here — the question is which names exist, not where they live.
const listed = execFileSync(
  "go",
  ["run", "./cmd/zyvrod", "--node-types"],
  { cwd: engineDir, encoding: "utf8" }
)
const engineTypes = new Set(listed.split("\n").map((l) => l.trim()).filter(Boolean))

// What the frontend says. BUILT_IN_KINDS is a top-level array literal, so the
// types inside it are read from that span rather than from the whole file,
// which also contains `type: "text"` config fields.
const src = readFileSync(nodesTs, "utf8")
const start = src.indexOf("export const BUILT_IN_KINDS")
if (start === -1) {
  console.log("FAIL  BUILT_IN_KINDS is gone from nodes.ts; this check needs updating")
  process.exit(1)
}
const end = src.indexOf("\n]", start)
const span = src.slice(start, end === -1 ? undefined : end)
const frontendTypes = new Set([...span.matchAll(/^\s{2}\{\s*type:\s*"([A-Za-z]+)"/gm)].map((m) => m[1]))

const missing = [...engineTypes].filter((t) => !frontendTypes.has(t)).sort()
const extra = [...frontendTypes].filter((t) => !engineTypes.has(t)).sort()

if (missing.length === 0 && extra.length === 0) {
  console.log(`Palette agrees with the engine (${frontendTypes.size} nodes).`)
  process.exit(0)
}
if (missing.length) {
  console.log(`FAIL  the engine runs these and the web palette does not offer them:\n        ${missing.join(", ")}`)
  console.log("      add them to BUILT_IN_KINDS in Zyvro-frontend/src/lib/nodes.ts")
}
if (extra.length) {
  console.log(`FAIL  the web palette offers these and the engine has no such node:\n        ${extra.join(", ")}`)
  console.log("      a workflow using one of them fails on 'unknown node type'")
}
process.exit(1)
