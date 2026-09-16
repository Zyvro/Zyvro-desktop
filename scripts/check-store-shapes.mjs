// The desktop describes the store's JSON in TypeScript, and TypeScript cannot
// check a description against a server. Three bugs in one day came from that
// gap, all the same shape:
//
//   - publishing sent `graph` where the server reads `graph_json`
//   - installing read `workflow` where the server sends `template`
//   - a listing read `author` where the server sends `publisher_name`
//
// Each compiled, each type-checked, and each failed the first time a person
// pressed the button. So this asks the real store what it sends and checks the
// fields we depend on are there.
//
// It skips when the store cannot be reached, because a build on a train is not
// a build that should fail — the point is to catch drift, not to require the
// network.
//
//     node scripts/check-store-shapes.mjs
const ORIGIN = process.env.ZYVRO_STORE_ORIGIN || "https://server.zyv.ro"

async function get(pathname) {
  const res = await fetch(`${ORIGIN}${pathname}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${pathname} answered ${res.status}`)
  return res.json()
}

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// The fields this app actually reads, named here so the check fails when one
// disappears rather than when the whole shape changes.
const TEMPLATE_FIELDS = ["name", "version", "description", "graph_json", "requires", "node_types", "publisher_name"]
const PACK_FIELDS = ["name", "version", "description", "author", "capabilities"]

let listing
try {
  listing = await get("/api/store/workflows")
} catch (err) {
  console.log(`skipped: the store is not reachable (${err.message})`)
  process.exit(0)
}

check("the workflow listing is keyed `templates`", Array.isArray(listing.templates))
const template = listing.templates?.[0]
if (!template) {
  console.log("skipped: the store has no workflow to check against")
  process.exit(0)
}
for (const field of TEMPLATE_FIELDS) {
  check(`a template carries \`${field}\``, field in template, `it has: ${Object.keys(template).join(", ")}`)
}
check("a template carries `preview`", "preview" in template)

const detail = await get(`/api/store/workflows/${encodeURIComponent(template.name)}`)
check("the detail route is keyed `template`", Boolean(detail.template))
check("it reports `installable`", typeof detail.installable === "boolean")
check("it reports `problems`", Array.isArray(detail.problems))
check("dependencies arrive under `packs`", Array.isArray(detail.packs))

const packs = await get("/api/store/nodes")
check("the node listing is keyed `packs`", Array.isArray(packs.packs))
if (packs.packs?.[0]) {
  for (const field of PACK_FIELDS) {
    check(`a pack carries \`${field}\``, field in packs.packs[0])
  }
  // The pinned route wraps its answer and the latest one does not. Reading the
  // wrapper as a pack was one of the three bugs.
  const pinned = await get(`/api/store/nodes/${encodeURIComponent(packs.packs[0].name)}/${encodeURIComponent(packs.packs[0].version)}`)
  check("a pinned version answers wrapped in `pack`", Boolean(pinned.pack))
} else {
  console.log("  (no published pack to check the node routes against)")
}

console.log(failures === 0 ? "\nThe store sends what this app reads." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
