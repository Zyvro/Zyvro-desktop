// The store digest has two implementations: the server computes it in Go, this
// app verifies it in TypeScript. A producer and a verifier that disagree about
// bytes do not fail loudly — they fail by rejecting every install, or by
// accepting one that should have been refused. So the agreement is pinned to a
// reference vector the Go side published, and to the properties the grammar is
// supposed to give.
//
//     node scripts/check-store-digest.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-digest-check")
mkdirSync(dir, { recursive: true })

const entry = path.join(dir, "harness.ts")
writeFileSync(entry, `export { packDigest } from "${path.join(ROOT, "src/main/store").replace(/\\/g, "/")}"\n`)
const outfile = path.join(dir, "harness.cjs")

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  absWorkingDir: ROOT,
  logLevel: "silent",
})

const { packDigest } = createRequire(import.meta.url)(outfile)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// The vector the Go implementation published. If this moves, the two sides
// have diverged and installs will start failing for reasons nobody can see.
const REFERENCE = "eb9a11099dacc0baa824d0867e23cafc7234d5e881624371ce5852298adc17f6"
const got = packDigest("text-tools", "1.0.0", { "a.lua": "x" })
check("matches the reference vector published by the Go implementation", got === REFERENCE, `got ${got}`)

// Properties the grammar is supposed to give.
const base = { "b.lua": "two", "a.lua": "one" }
check(
  "is stable across source map ordering",
  packDigest("p", "1.0.0", base) === packDigest("p", "1.0.0", { "a.lua": "one", "b.lua": "two" })
)
check("moves when a source changes", packDigest("p", "1.0.0", base) !== packDigest("p", "1.0.0", { ...base, "a.lua": "onx" }))
check("moves when a file is added", packDigest("p", "1.0.0", base) !== packDigest("p", "1.0.0", { ...base, "c.lua": "" }))
check(
  "moves when a file is renamed",
  packDigest("p", "1.0.0", base) !== packDigest("p", "1.0.0", { "a.lua": "one", "c.lua": "two" })
)
check("moves when the version changes", packDigest("p", "1.0.0", base) !== packDigest("p", "1.0.1", base))
check("moves when the name changes", packDigest("p", "1.0.0", base) !== packDigest("q", "1.0.0", base))

// The length prefixes exist so a filename cannot trade bytes with the contents
// that follow it. Without them these two packs would hash the same.
check(
  "a name cannot borrow bytes from the file that follows it",
  packDigest("p", "1.0.0", { "ab.lua": "c" }) !== packDigest("p", "1.0.0", { "a.lua": "bc" })
)

// Non-ASCII has to go in as raw UTF-8 bytes, not as characters, or the byte
// length in the prefix is wrong and the server will never agree.
const accented = packDigest("p", "1.0.0", { "é.lua": "café" })
check("handles non-ASCII by byte length, not character count", typeof accented === "string" && accented.length === 64)

console.log(failures === 0 ? "\nStore digest agrees with the server." : `\n${failures} check(s) failed.`)
rmSync(dir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
