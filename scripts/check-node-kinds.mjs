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

// La deuxième question, et c'est la même forme : quels nœuds une exécution
// peut-elle remplir par leur nom ?
//
// L'éditeur décide s'il propose un nom à un nœud ; le moteur décide si ce nom
// sert à quelque chose. Un miroir de plus, et celui-ci se paie cher : un nœud
// d'entrée à qui l'éditeur ne propose pas de nom ne se remplace qu'en
// désignant son identifiant, qui n'est écrit nulle part — un agent à qui on
// demande « refais-le avec ce fichier » tourne alors sur la valeur d'origine et
// rend un résultat qui a l'air juste.
const engineInputTypes = new Set(
  execFileSync("go", ["run", "./cmd/zyvrod", "--runtime-input-types"], { cwd: engineDir, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
)
const inputSpan = src.slice(src.indexOf("export const RUNTIME_INPUT_TYPES"))
const frontendInputTypes = new Set(
  [...inputSpan.slice(0, inputSpan.indexOf("]")).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])
)
const inputMissing = [...engineInputTypes].filter((t) => !frontendInputTypes.has(t)).sort()
const inputExtra = [...frontendInputTypes].filter((t) => !engineInputTypes.has(t)).sort()

const missing = [...engineTypes].filter((t) => !frontendTypes.has(t)).sort()
const extra = [...frontendTypes].filter((t) => !engineTypes.has(t)).sort()

if (missing.length === 0 && extra.length === 0 && inputMissing.length === 0 && inputExtra.length === 0) {
  console.log(
    `Palette agrees with the engine (${frontendTypes.size} nodes), ` +
      `and so does the list of inputs a run can fill by name (${frontendInputTypes.size}).`
  )
  process.exit(0)
}
if (inputMissing.length) {
  console.log(
    `FAIL  a run can fill these by name and the editor offers no name for them:\n        ${inputMissing.join(", ")}`
  )
  console.log("      add them to RUNTIME_INPUT_TYPES in Zyvro-frontend/src/lib/nodes.ts")
}
if (inputExtra.length) {
  console.log(
    `FAIL  the editor offers a runtime name on these and the engine never reads it:\n        ${inputExtra.join(", ")}`
  )
  console.log("      the name would look like it works and fill nothing")
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
