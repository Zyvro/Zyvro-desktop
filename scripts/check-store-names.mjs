// The store refuses a name that is not lowercase letters, digits and dashes,
// and refuses a name@version that already exists. This app has to satisfy both
// before it sends anything, and it did not: it published a workflow's title
// verbatim, so "Untitled workflow" came back a 400 and publishing from the
// desktop simply never worked.
//
// The rules live on the server. These are its two regexes, copied here, and the
// point of this check is that what we generate satisfies them.
//
//     node scripts/check-store-names.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-name-check")
mkdirSync(dir, { recursive: true })

const entry = path.join(dir, "harness.ts")
writeFileSync(
  entry,
  `export { storeName, nextVersion } from "${path.join(ROOT, "src/main/store").replace(/\\/g, "/")}"\n`
)
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
const { storeName, nextVersion } = createRequire(import.meta.url)(outfile)

// Copied from Zyvro-backend/api/store.go.
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

for (const title of [
  "Untitled workflow",
  "Brain QA Loop",
  "2.0-tiles-to-1.29",
  "Générateur d'images",
  "  spaces   everywhere  ",
  "UPPER_SNAKE_CASE",
  "a".repeat(120),
]) {
  const slug = storeName(title)
  check(`"${title.slice(0, 28)}" -> "${slug}"`, NAME.test(slug), `does not satisfy ${NAME}`)
}

// A title with nothing to slugify has to come back empty so the caller can say
// so, rather than silently publishing under a name the author never chose.
check('a title with no letters or digits gives ""', storeName("!!! ---") === "")
check('an empty title gives ""', storeName("") === "")

check("first publish is 1.0.0", nextVersion(null) === "1.0.0")
check("a second publish bumps the patch", nextVersion("1.0.0") === "1.0.1")
check("it carries tens", nextVersion("1.2.9") === "1.2.10")
check("a version it cannot read is extended, not mangled", nextVersion("2024-06") === "2024-06.1")
for (const v of [nextVersion(null), nextVersion("1.0.0"), nextVersion("2024-06")]) {
  check(`"${v}" satisfies the server`, VERSION.test(v))
}

console.log(failures === 0 ? "\nStore names and versions satisfy the server." : `\n${failures} check(s) failed.`)
rmSync(dir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
