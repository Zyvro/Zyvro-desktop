// The password never leaves this machine.
//
// The same two derivations as Zyvro-frontend/src/lib/kdf.ts, and they have to
// agree byte for byte: the same account signs in from the web app and from
// here, and a client that derived differently would simply be told its password
// is wrong. That is why this uses PBKDF2 through WebCrypto — present in the
// browser and in Node with no dependency and no WebAssembly — rather than
// Argon2id, which resists a GPU better but would need a library on each side
// and two chances to disagree.
//
// Unlike the browser, this guarantee actually holds here: this code is
// installed, not delivered by the server on every visit. Which is the reason
// publishing, and the signing key it needs, lives in this app.

export type KdfParams = {
  kdf_version: number
  kdf_iterations: number
  kdf_salt: string
}

const encoder = new TextEncoder()

async function pbkdf2(secret: ArrayBuffer | string, salt: string, iterations: number): Promise<ArrayBuffer> {
  const raw = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret)
  const material = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveBits"])
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations },
    material,
    256
  )
}

export async function deriveMasterKey(password: string, params: KdfParams): Promise<ArrayBuffer> {
  return pbkdf2(password, params.kdf_salt, params.kdf_iterations)
}

// deriveAuthHash is what goes over the wire, in place of the password. One
// iteration, because its job is separation and not cost: the expense was paid
// deriving the master key, and no iteration count would let the server run this
// backwards.
export async function deriveAuthHash(password: string, params: KdfParams): Promise<string> {
  const master = await deriveMasterKey(password, params)
  return Buffer.from(await pbkdf2(master, password, 1)).toString("base64")
}
