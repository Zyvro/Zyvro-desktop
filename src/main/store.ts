import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { anonymous, authorized, StoreError } from "./account"

// The store hands this process Lua source from strangers and asks it to write
// that source into the user's project. Everything here is written on the
// assumption that the response is hostile: a pack name and a file name are
// both path segments, and the one thing that must never happen is a download
// writing outside the packs directory.
//
// What the code does once installed is the sandbox's problem, not this file's.

const PACK_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const SOURCE_NAME = /^[A-Za-z0-9_-]{1,64}\.lua$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/

const MAX_SOURCE_BYTES = 512 * 1024
const MAX_SOURCES = 64

// packDigest reproduces the server's digest byte for byte. The grammar is
// copied here rather than approximated, because a producer and a verifier that
// disagree about bytes do not fail loudly: they fail by rejecting everything,
// or by accepting anything.
//
//   digest    = lowercase-hex( SHA-256( preimage ) )
//   preimage  = prefix field(name) field(version) count file*
//   prefix    = "zyvro-pack-digest-v1" LF
//   count     = decimal(number of files) LF
//   file      = field(filename) field(contents)
//   field(x)  = decimal(byte-length of x) LF x LF
//   decimal   = ASCII base ten, no leading zeros, "0" for zero
//   LF        = byte 0x0A
//
// Files are in ascending filename order, compared as byte strings. Every field
// carries its own byte length, so no filename can trade bytes with the file
// that follows it.
export function packDigest(name: string, version: string, sources: Record<string, string>): string {
  const field = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8")
    return Buffer.concat([Buffer.from(`${bytes.length}\n`, "ascii"), bytes, Buffer.from("\n", "ascii")])
  }

  const names = Object.keys(sources).sort((a, b) =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))
  )

  const parts: Buffer[] = [
    Buffer.from("zyvro-pack-digest-v1\n", "ascii"),
    field(name),
    field(version),
    Buffer.from(`${names.length}\n`, "ascii"),
  ]
  for (const file of names) {
    parts.push(field(file), field(sources[file]))
  }

  return createHash("sha256").update(Buffer.concat(parts)).digest("hex")
}

export type StoreListing = {
  name: string
  version: string
  description: string
  author: string
  capabilities: string[]
  nodeTypes?: string[]
  digest?: string
  updatedAt: string
}

// The store carries sources as a list of {path, code}, not as a map. A map
// cannot round-trip through the digest either: the digest is defined over an
// ordered list of files, and JSON objects have no order.
export type StoreSource = { path: string; code: string }

export type StorePack = StoreListing & {
  manifest?: Record<string, unknown>
  sources: StoreSource[]
}

// sourceMap turns the wire shape into the one the digest and the writer want.
// A duplicate path would let two files disagree about which one is installed,
// so it is a refusal rather than a last-one-wins.
function sourceMap(sources: StoreSource[], pack: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const source of sources ?? []) {
    if (typeof source?.path !== "string" || typeof source?.code !== "string") {
      throw new StoreError(`The pack "${pack}" contains a malformed source entry.`)
    }
    if (source.path in out) {
      throw new StoreError(`The pack "${pack}" lists "${source.path}" twice.`)
    }
    out[source.path] = source.code
  }
  return out
}

export type StoreWorkflow = {
  name: string
  description: string
  author: string
  graph: unknown
  requires: { name: string; version: string; digest?: string }[]
  updatedAt: string
}

export type InstallResult = {
  workflow?: string
  packs: { name: string; version: string }[]
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

// The two listings name their array after what it holds. Reading a single
// agreed key would have been tidier; reading the one the server actually sends
// is what makes the panel show anything, and a silent empty list is the worst
// possible failure here because it looks exactly like an empty store.
export async function listNodes(q = "", limit = 50): Promise<StoreListing[]> {
  const body = (await anonymous(`/api/store/nodes${query({ q, limit })}`)) as {
    packs?: StoreListing[]
  }
  return Array.isArray(body?.packs) ? body.packs : []
}

export async function listWorkflows(q = "", limit = 50): Promise<StoreWorkflow[]> {
  const body = (await anonymous(`/api/store/workflows${query({ q, limit })}`)) as {
    workflows?: StoreWorkflow[]
    templates?: StoreWorkflow[]
  }
  return body?.workflows ?? body?.templates ?? []
}

// readPack fetches a pack's sources without installing anything, which is what
// makes the store readable: someone can look at the Lua before deciding.
export async function readPack(name: string, version?: string): Promise<StorePack> {
  assertName(name)
  if (version) assertVersion(version)
  const suffix = version ? `/${encodeURIComponent(version)}` : ""
  return (await anonymous(`/api/store/nodes/${encodeURIComponent(name)}${suffix}`)) as StorePack
}

function assertName(name: string): void {
  if (!PACK_NAME.test(name)) throw new StoreError(`"${name}" is not a valid pack name.`)
}

function assertVersion(version: string): void {
  if (!VERSION.test(version)) throw new StoreError(`"${version}" is not a valid version.`)
}

// writePack is the only function that writes a download to disk. Every name it
// uses is checked against a pattern first, so no value from the response is
// ever joined onto a path unvalidated.
async function writePack(projectDir: string, pack: StorePack): Promise<void> {
  assertName(pack.name)
  assertVersion(pack.version)

  const sources = sourceMap(pack.sources, pack.name)

  // The server says what a version's bytes should hash to. Checking it here is
  // what makes that promise worth anything: a store that served different bytes
  // under a version someone already reviewed is exactly the attack immutability
  // is meant to stop, and it is invisible without this.
  if (pack.digest) {
    const computed = packDigest(pack.name, pack.version, sources)
    if (computed !== pack.digest.toLowerCase()) {
      throw new StoreError(
        `The content of ${pack.name}@${pack.version} does not match the digest the store published for it. Refusing to install it.`
      )
    }
  }
  const names = Object.keys(sources)
  if (names.length === 0) throw new StoreError(`The pack "${pack.name}" carries no nodes.`)
  if (names.length > MAX_SOURCES) {
    throw new StoreError(`The pack "${pack.name}" declares ${names.length} files; the limit is ${MAX_SOURCES}.`)
  }
  for (const name of names) {
    if (!SOURCE_NAME.test(name)) {
      throw new StoreError(`The pack "${pack.name}" contains a file named "${name}", which is refused.`)
    }
    const size = Buffer.byteLength(sources[name], "utf8")
    if (size > MAX_SOURCE_BYTES) {
      throw new StoreError(`"${name}" is ${size} bytes; the limit is ${MAX_SOURCE_BYTES}.`)
    }
  }

  const root = await fs.realpath(projectDir)
  const dir = path.join(root, ".zyvro", "packs", pack.name)
  // Belt and braces after the pattern check: if the resolved directory is not
  // under the packs folder, something got past the name check and nothing
  // should be written.
  const packsRoot = path.join(root, ".zyvro", "packs")
  if (path.relative(packsRoot, dir).startsWith("..")) {
    throw new StoreError(`Refused to install "${pack.name}" outside the packs folder.`)
  }

  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(path.join(dir, "nodes"), { recursive: true })
  await fs.writeFile(
    path.join(dir, "zyvro-pack.json"),
    JSON.stringify({ ...pack.manifest, name: pack.name, version: pack.version }, null, 2),
    "utf8"
  )
  for (const [name, source] of Object.entries(sources)) {
    await fs.writeFile(path.join(dir, "nodes", name), source, "utf8")
  }
}

export async function installPack(projectDir: string, name: string, version?: string): Promise<InstallResult> {
  const pack = await readPack(name, version)
  await writePack(projectDir, pack)
  return { packs: [{ name: pack.name, version: pack.version }] }
}

// installWorkflow takes the whole closure in one exchange. A workflow whose
// nodes arrive separately can be installed half-way, which leaves the user
// with a graph that names a type nothing provides.
export async function installWorkflow(projectDir: string, name: string): Promise<InstallResult> {
  const body = (await anonymous(`/api/store/workflows/${encodeURIComponent(name)}`)) as {
    workflow?: StoreWorkflow
    packs?: StorePack[]
    missing?: { name: string; reason: string }[]
  }

  if (body?.missing?.length) {
    const named = body.missing.map((m) => `${m.name} (${m.reason})`).join(", ")
    throw new StoreError(`This workflow cannot be installed: ${named}`)
  }
  if (!body?.workflow) throw new StoreError(`The store returned no workflow named "${name}".`)

  const packs = body.packs ?? []
  // Every pack is validated before any of them is written, so a bad one in the
  // middle of the closure cannot leave a half-installed set behind.
  for (const pack of packs) {
    assertName(pack.name)
    assertVersion(pack.version)
  }
  for (const pack of packs) await writePack(projectDir, pack)

  return {
    workflow: body.workflow.name,
    packs: packs.map((p) => ({ name: p.name, version: p.version })),
  }
}

export type InstalledPack = {
  name: string
  version: string
  description: string
  author: string
  capabilities: string[]
  sources: StoreSource[]
}

// listInstalledPacks reads what the project actually carries, which is what a
// publish has to be built from. The manifest on disk is the truth; asking the
// daemon would give the loaded set, and a pack that failed to load is exactly
// the one someone is trying to fix and publish.
export async function listInstalledPacks(projectDir: string): Promise<InstalledPack[]> {
  const root = await fs.realpath(projectDir)
  const packsRoot = path.join(root, ".zyvro", "packs")
  let entries: string[]
  try {
    entries = await fs.readdir(packsRoot)
  } catch {
    return []
  }

  const packs: InstalledPack[] = []
  for (const name of entries) {
    if (!PACK_NAME.test(name)) continue
    try {
      packs.push(await readInstalledPack(root, name))
    } catch {
      // A pack that cannot be read is not publishable, and the store panel
      // lists what can be published rather than everything that exists.
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name))
}

export async function readInstalledPack(projectDir: string, name: string): Promise<InstalledPack> {
  assertName(name)
  const root = await fs.realpath(projectDir)
  const dir = path.join(root, ".zyvro", "packs", name)

  const manifest = JSON.parse(await fs.readFile(path.join(dir, "zyvro-pack.json"), "utf8")) as Record<
    string,
    unknown
  >
  const nodesDir = path.join(dir, "nodes")
  // Sorted, because the digest is defined over files in ascending name order
  // and a publish that sends them in another order would hash differently from
  // what the store computes.
  const files = (await fs.readdir(nodesDir)).filter((f) => SOURCE_NAME.test(f)).sort()
  const sources: StoreSource[] = []
  for (const file of files) {
    sources.push({ path: file, code: await fs.readFile(path.join(nodesDir, file), "utf8") })
  }

  return {
    name,
    version: String(manifest.version ?? "0.0.0"),
    description: String(manifest.description ?? ""),
    author: String(manifest.author ?? ""),
    capabilities: Array.isArray(manifest.capabilities) ? (manifest.capabilities as string[]) : [],
    sources,
  }
}

export async function publishPack(projectDir: string, name: string): Promise<unknown> {
  const pack = await readInstalledPack(projectDir, name)
  return authorized("/api/store/nodes", {
    method: "POST",
    body: JSON.stringify({
      name: pack.name,
      version: pack.version,
      description: pack.description,
      author: pack.author,
      capabilities: pack.capabilities,
      sources: pack.sources,
    }),
  })
}

// storeName turns a workflow's title into a name the store will accept:
// lowercase letters, digits and dashes, starting on a letter or digit.
//
// The server's rule is not a suggestion — "Untitled workflow" was refused
// outright, which is how publishing from this app came to be broken.
export function storeName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")
  return slug
}

// nextVersion is the version to publish under: the first one, or one patch past
// whatever is already published under this name.
//
// Without it the app could publish a given workflow exactly once and then only
// ever collide — the server refuses a name@version that exists, and rightly so,
// because somebody may have that exact version installed.
export function nextVersion(latest: string | null): string {
  if (!latest) return "1.0.0"
  const parts = latest.split(".")
  const numeric = parts.length === 3 && parts.every((p) => /^\d+$/.test(p))
  if (!numeric) return `${latest}.1`
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`
}

async function publishedVersion(name: string): Promise<string | null> {
  try {
    const body = (await anonymous(`/api/store/workflows/${encodeURIComponent(name)}`)) as {
      template?: { version?: string }
    }
    return body?.template?.version ?? null
  } catch {
    // Not published yet is the common case and reads as an error from the
    // fetch. Anything else here would only cost a version bump, never a wrong
    // publish: the server refuses a collision either way.
    return null
  }
}

// publishWorkflow sends the graph and lets the server derive what it needs. A
// dependency the store does not have comes back named, which is what the panel
// turns into "publish these packs first" rather than a dead end.
//
// The workflow id travels with it so the server can copy the preview off the
// publisher's own workflow: a catalogue of names is a catalogue nobody browses.
export async function publishWorkflow(payload: {
  id: string
  name: string
  description: string
  graph: unknown
}): Promise<unknown> {
  const name = storeName(payload.name)
  if (!name) {
    throw new StoreError(
      `"${payload.name}" has no letters or digits to make a store name from. Rename the workflow and try again.`
    )
  }
  const body = {
    name,
    version: nextVersion(await publishedVersion(name)),
    description: payload.description,
    graph_json: payload.graph,
    source_workflow_id: payload.id,
  }
  return authorized("/api/store/workflows", { method: "POST", body: JSON.stringify(body) })
}
