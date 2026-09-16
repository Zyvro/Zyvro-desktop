import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { app } from "electron"

// The engine is a native executable that runs with the user's full privileges:
// it reads and writes their project, spawns their CLIs and holds their provider
// keys. So this module treats every byte it downloads as hostile until an
// Ed25519 signature made by a key that does not live on the server says
// otherwise. HTTPS proves who served the file; the signature proves who built
// it, and only the second one survives a compromised server or CDN.
//
// It fails closed. No public key, no signature, a hash that does not match, a
// version that is not strictly newer: no install.

const DEFAULT_ORIGIN = "https://server.zyv.ro"
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_BINARY_BYTES = 128 * 1024 * 1024

export type EngineManifest = {
  version: string
  platform: string
  size: number
  sha256: string
  released_at: string
  notes?: string
  signature: string
  url: string
}

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current"; version: string; checkedAt: string }
  | { status: "available"; current: string; manifest: EngineManifest; checkedAt: string }
  | { status: "downloading"; manifest: EngineManifest; receivedBytes: number; totalBytes: number }
  | { status: "installed"; version: string; restartRequired: true }
  | { status: "failed"; message: string; checkedAt: string }

export function updateOrigin(): string {
  return process.env.ZYVRO_UPDATE_ORIGIN || DEFAULT_ORIGIN
}

// platformKey names the artifact this machine can run. It is sent to the
// server and used as a path segment, so it is built from a fixed mapping rather
// than interpolated from whatever process.platform happens to say.
export function platformKey(): string | null {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null
  if (!os || !arch) return null
  return `${os}-${arch}`
}

// ---------- versions ----------

// compareVersions returns >0 when a is newer. It understands the shape the
// release script produces (v1.4.0, 1.4.0-rc1, 1.4.0-3-gabc1234) and treats
// anything it cannot parse as older, so an unparseable version never wins.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    if (!match) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const left = parse(a)
  const right = parse(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  // Equal release numbers: a plain version beats a pre-release of the same one.
  const pre = (v: string) => /-/.test(v.trim().replace(/^v/, "").replace(/^\d+\.\d+\.\d+/, ""))
  const aPre = pre(a)
  const bPre = pre(b)
  if (aPre === bPre) return 0
  return aPre ? -1 : 1
}

// ---------- signature ----------

// The public half of the release key ships with the app. Keeping it in a file
// rather than in the source means rotating it is a release, not a code change.
async function releasePublicKey(): Promise<string | null> {
  const candidates = [
    process.env.ZYVRO_RELEASE_PUBKEY,
    path.join(process.resourcesPath || "", "engine-release.pub"),
    path.join(app.getAppPath(), "resources", "engine-release.pub"),
  ].filter((p): p is string => Boolean(p))

  for (const candidate of candidates) {
    try {
      const pem = await fs.readFile(candidate, "utf8")
      if (pem.includes("PUBLIC KEY")) return pem
    } catch {
      // Try the next location.
    }
  }
  return null
}

// canonicalPayload must produce exactly the bytes the signing tool signed.
// A signer and a verifier that disagree about serialization do not fail loudly;
// they fail by accepting nothing, or worse by accepting anything, so this is
// deliberately dull: every field except the signature, keys sorted, no spaces.
export function canonicalPayload(manifest: Record<string, unknown>): string {
  const entries = Object.entries(manifest)
    .filter(([key]) => key !== "signature" && key !== "url")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(Object.fromEntries(entries))
}

export async function verifyManifest(manifest: EngineManifest): Promise<true> {
  const pem = await releasePublicKey()
  if (!pem) {
    throw new Error("This build carries no engine release key, so engine updates are turned off.")
  }
  const key = createPublicKey(pem)
  const payload = Buffer.from(canonicalPayload(manifest as unknown as Record<string, unknown>), "utf8")
  const signature = Buffer.from(manifest.signature, "base64")
  // Ed25519 takes no digest argument; passing one silently changes the scheme.
  if (!verifySignature(null, payload, key, signature)) {
    throw new Error("The update manifest is not signed by the Zyvro release key. Refusing it.")
  }
  return true
}

// ---------- fetching ----------

export async function fetchManifest(platform: string, channel = "stable"): Promise<EngineManifest> {
  const url = `${updateOrigin()}/api/engine/latest?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}`
  const response = await fetch(url, { redirect: "error" })
  if (response.status === 404) throw new Error(`No engine release published for ${platform}.`)
  if (!response.ok) throw new Error(`The update server answered ${response.status}.`)

  const manifest = (await response.json()) as EngineManifest
  if (typeof manifest?.version !== "string" || typeof manifest?.sha256 !== "string") {
    throw new Error("The update server returned a manifest this app cannot read.")
  }
  await verifyManifest(manifest)
  if (manifest.platform !== platform) {
    throw new Error(`The server offered an engine for ${manifest.platform}, not ${platform}.`)
  }
  return manifest
}

// ---------- install ----------

export function engineInstallDir(version: string): string {
  return path.join(app.getPath("userData"), "engines", version)
}

function binaryName(): string {
  return process.platform === "win32" ? "zyvrod.exe" : "zyvrod"
}

// installedEngine returns the newest engine this app has installed, if any.
// A downloaded engine outranks the bundled one only while it is strictly newer,
// which is what stops a replayed old manifest from pushing a user backwards.
export async function installedEngine(): Promise<{ version: string; path: string } | null> {
  const root = path.join(app.getPath("userData"), "engines")
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return null
  }
  let best: { version: string; path: string } | null = null
  for (const version of entries) {
    const candidate = path.join(root, version, binaryName())
    try {
      await fs.access(candidate, fsConstants.X_OK)
    } catch {
      continue
    }
    if (!best || compareVersions(version, best.version) > 0) best = { version, path: candidate }
  }
  return best
}

export type DownloadProgress = (received: number, total: number) => void

// download fetches the artifact, then checks it twice: the hash the signed
// manifest committed to, and the size. Only then does it become executable,
// and only in its final location, by rename. A partially written file is never
// nameable as an engine.
export async function downloadEngine(manifest: EngineManifest, onProgress?: DownloadProgress): Promise<string> {
  await verifyManifest(manifest)

  if (!/^https:\/\//i.test(manifest.url) && !process.env.ZYVRO_UPDATE_ORIGIN) {
    throw new Error("The update artifact is not served over HTTPS. Refusing it.")
  }
  if (manifest.size > MAX_BINARY_BYTES) {
    throw new Error(`The offered engine is ${manifest.size} bytes, which is larger than this app will install.`)
  }

  // Redirects are followed here, unlike for the manifest: a release artifact
  // usually sits behind a CDN. It is safe because what arrives is checked
  // against a hash the release key already signed, so where the bytes came from
  // does not change whether they are accepted.
  const response = await fetch(manifest.url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`Downloading the engine failed with ${response.status}.`)

  const hash = createHash("sha256")
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk)
    received += buffer.length
    if (received > manifest.size) throw new Error("The engine download is larger than the manifest declared.")
    hash.update(buffer)
    chunks.push(buffer)
    onProgress?.(received, manifest.size)
  }

  if (received !== manifest.size) {
    throw new Error(`The engine download is ${received} bytes; the manifest declared ${manifest.size}.`)
  }
  const digest = hash.digest("hex")
  if (digest !== manifest.sha256.toLowerCase()) {
    throw new Error("The engine download does not match the hash the release was signed for. Refusing it.")
  }

  const dir = engineInstallDir(manifest.version)
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, binaryName())
  const temp = `${target}.partial`
  await fs.writeFile(temp, Buffer.concat(chunks), { mode: 0o755 })
  await fs.rename(temp, target)
  // The manifest is kept beside the binary so a later run can tell where this
  // engine came from without trusting the directory name.
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  return target
}

// quarantine moves an engine aside after it failed to start, so the next launch
// falls back to the one that works instead of retrying a broken binary forever.
export async function quarantineEngine(version: string): Promise<void> {
  const dir = engineInstallDir(version)
  try {
    await fs.rename(dir, `${dir}.broken-${Date.now()}`)
  } catch {
    // If it cannot be moved it will fail its handshake again and be skipped.
  }
}

export const CHECK_INTERVAL = CHECK_INTERVAL_MS
