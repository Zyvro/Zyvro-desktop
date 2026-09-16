import fs from "node:fs/promises"
import path from "node:path"
import { deriveAuthHash, type KdfParams } from "./kdf"
import { app } from "electron"

// Publishing to the store needs an account, so this process holds a credential
// for server.zyv.ro. Two rules shape everything here.
//
// The credential never reaches the renderer. The window asks "am I signed in"
// and "publish this"; it is never handed the token, because the renderer
// displays model output and workflow content and is the part of the app most
// likely to be tricked into leaking something.
//
// The password is never stored. Signing in exchanges it for an API key, which
// is revocable from the account page and scoped the way the server scopes keys.
// A stored password is a stored password no matter how it is encrypted locally.

const DEFAULT_ORIGIN = "https://server.zyv.ro"

// CURRENT_KDF_VERSION must match the server's KDFVersion. Prelogin is what
// keeps the two honest: the server names the version for every account.
const CURRENT_KDF_VERSION = 1

export type Account = { id: string; email: string; name: string }

type Stored = { origin: string; key: string; account: Account }

export function storeOrigin(): string {
  return process.env.ZYVRO_STORE_ORIGIN || DEFAULT_ORIGIN
}

function credentialFile(): string {
  return path.join(app.getPath("userData"), "account.json")
}

let cached: Stored | null | undefined

async function read(): Promise<Stored | null> {
  if (cached !== undefined) return cached
  try {
    const raw = await fs.readFile(credentialFile(), "utf8")
    const parsed = JSON.parse(raw) as Stored
    // A credential minted against a different server is not a credential for
    // this one. It happens when someone points the app at a test instance and
    // back again, and silently sending the wrong key would read as a bad
    // password rather than as the configuration mistake it is.
    cached = parsed?.key && parsed.origin === storeOrigin() ? parsed : null
  } catch {
    cached = null
  }
  return cached
}

async function write(value: Stored | null): Promise<void> {
  cached = value
  const file = credentialFile()
  if (!value) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.partial`
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(temp, file)
}

export class StoreError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.status = status
  }
}

async function call(pathname: string, init: RequestInit = {}, key?: string): Promise<unknown> {
  return (await callWithResponse(pathname, init, key)).body
}

// callWithResponse is call, also handing back the response headers. Sign-in
// needs the session cookie the login sets — once, to exchange it for a key —
// and there is nowhere else to read it from.
async function callWithResponse(
  pathname: string,
  init: RequestInit = {},
  key?: string
): Promise<{ body: unknown; setCookie: string | null }> {
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")
  if (key) headers.set("Authorization", `Bearer ${key}`)

  let response: Response
  try {
    response = await fetch(`${storeOrigin()}${pathname}`, { ...init, headers, redirect: "error" })
  } catch (err) {
    throw new StoreError(`Could not reach ${storeOrigin()}: ${(err as Error).message}`)
  }

  const text = await response.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`
    throw new StoreError(message, response.status)
  }
  return { body, setCookie: response.headers.get("set-cookie") }
}

// signIn exchanges a password for an API key and forgets the password. The
// session cookie the login returns is deliberately not kept: a desktop app
// carrying a browser session is a cookie jar nobody asked for, and a key can be
// revoked from the account page without changing the password.
export async function signIn(email: string, password: string): Promise<Account> {
  // The password is derived before it is sent; see kdf.ts. What crosses the
  // wire is an auth hash, and an account made before that existed carries its
  // own migration in the same request.
  const params = (await call("/api/auth/prelogin", {
    method: "POST",
    body: JSON.stringify({ email }),
  })) as KdfParams

  const payload: Record<string, unknown> =
    params.kdf_version === 0
      ? {
          email,
          password,
          kdf_version: CURRENT_KDF_VERSION,
          upgrade_hash: await deriveAuthHash(password, { ...params, kdf_version: CURRENT_KDF_VERSION }),
        }
      : { email, password: await deriveAuthHash(password, params), kdf_version: params.kdf_version }

  const { body, setCookie } = await callWithResponse("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  })
  const login = body as Account & { id: string }

  // The session is used once, here, and never written down. Minting the key
  // needs an authenticated request and this process keeps no cookie jar — it
  // used to send the password to a route that does not read one, so sign-in
  // failed at this exact step with "missing session cookie" and nobody could
  // publish anything.
  const cookieless = await mintKey(setCookie)
  const account: Account = { id: login.id, email: login.email, name: login.name }
  await write({ origin: storeOrigin(), key: cookieless, account })
  return account
}

// mintKey asks the server for a key on behalf of the account that just signed
// in, carrying the session from that login and nothing else.
//
// The cookie is passed as a header on this one request and then forgotten: a
// desktop app holding a browser session is a cookie jar nobody asked for, and a
// key can be revoked from the account page without changing the password.
async function mintKey(setCookie: string | null): Promise<string> {
  if (!setCookie) {
    throw new StoreError("The server signed this account in but issued no session, so no key could be made.")
  }
  const cookie = setCookie.split(";", 1)[0]
  const created = (await call("/api/keys", {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: `Zyvro Studio on ${hostLabel()}` }),
  })) as { key?: string; token?: string }
  const key = created.key || created.token
  if (!key) throw new StoreError("The server did not return an API key for this app.")
  return key
}

function hostLabel(): string {
  return `${process.platform}-${process.arch}`
}

export async function currentAccount(): Promise<Account | null> {
  return (await read())?.account ?? null
}

export async function signOut(): Promise<void> {
  await write(null)
}

// authorized runs a call with the stored key. It is the only way the rest of
// the app reaches an endpoint that needs an account, which keeps the key in
// this file.
export async function authorized(pathname: string, init: RequestInit = {}): Promise<unknown> {
  const stored = await read()
  if (!stored) throw new StoreError("Sign in to publish to the store.", 401)
  try {
    return await call(pathname, init, stored.key)
  } catch (err) {
    // A revoked key is indistinguishable from a wrong one, and leaving it in
    // place would make every later action fail the same way with no hint.
    if (err instanceof StoreError && err.status === 401) await write(null)
    throw err
  }
}

export async function anonymous(pathname: string): Promise<unknown> {
  return call(pathname)
}
