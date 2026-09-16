import { createHash, generateKeyPairSync, sign as nodeSign, createPrivateKey, createPublicKey, verify as nodeVerify, randomBytes, webcrypto } from "node:crypto"
import { deriveMasterKey, type KdfParams } from "./kdf"

// A publisher's signing key.
//
// It is generated here, on the publisher's own machine, and it leaves only
// sealed: encrypted with a key derived from their password, which the server
// never sees. The server keeps the sealed blob so that publishing from a second
// machine is possible — the alternative, a key that exists on one laptop only,
// makes losing the laptop mean losing the name you publish under.
//
// The password is needed to unseal it, which is why publishing asks for it.
// That is the cost of the arrangement and it is the right cost: a key that
// could be used without proving anything is a key an attacker who reached this
// machine could use too.

const KEY_INFO = "zyvro-vault-v1"

export type SealedKey = {
  publicKey: string
  wrappedPrivateKey: string
  kdfVersion: number
}

// vaultKey is derived from the same master key as the auth hash, by a different
// path, so holding one says nothing about the other.
async function vaultKey(password: string, params: KdfParams): Promise<webcrypto.CryptoKey> {
  const master = await deriveMasterKey(password, params)
  const hkdf = await webcrypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"])
  return webcrypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

// generateIdentity makes a new signing key and seals it in one step, so a
// private key never exists in a form that could be written down by accident.
export async function generateIdentity(password: string, params: KdfParams): Promise<SealedKey> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer

  return {
    // The raw 32 bytes, not the DER wrapper: that is what Ed25519 verification
    // takes on the other side, and what the server stores.
    publicKey: spki.subarray(spki.length - 32).toString("base64"),
    wrappedPrivateKey: await seal(pkcs8, password, params),
    kdfVersion: params.kdf_version,
  }
}

// seal encrypts with AES-GCM and keeps the nonce beside the ciphertext. A nonce
// is not a secret; reusing one would be the mistake, so it is drawn fresh every
// time rather than derived from anything.
async function seal(plain: Buffer, password: string, params: KdfParams): Promise<string> {
  const key = await vaultKey(password, params)
  const iv = randomBytes(12)
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain)
  return Buffer.concat([iv, Buffer.from(ciphertext)]).toString("base64")
}

async function unseal(wrapped: string, password: string, params: KdfParams): Promise<Buffer> {
  const raw = Buffer.from(wrapped, "base64")
  const key = await vaultKey(password, params)
  try {
    const plain = await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12) },
      key,
      raw.subarray(12)
    )
    return Buffer.from(plain)
  } catch {
    // AES-GCM fails closed on a wrong key, which is the only thing a wrong
    // password looks like from here.
    throw new Error("That password does not open this signing key.")
  }
}

// signDigest signs a pack's digest. The digest and not the bytes, because the
// digest is already the store's canonical statement of what a version contains
// and both sides already compute it the same way.
export async function signDigest(
  digest: string,
  sealed: SealedKey,
  password: string,
  params: KdfParams
): Promise<string> {
  const pkcs8 = await unseal(sealed.wrappedPrivateKey, password, params)
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
  return nodeSign(null, Buffer.from(digest), key).toString("base64")
}

// verifyDigest checks a pack against the key it claims to come from. Used when
// installing, where the answer decides whether somebody's Lua runs.
export function verifyDigest(digest: string, signature: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64")
    if (raw.length !== 32) return false
    // Node wants SPKI; the stored form is the bare 32 bytes, so the standard
    // Ed25519 prefix is put back rather than storing a wrapper the server and
    // the browser would both have to understand.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw])
    const key = createPublicKey({ key: spki, format: "der", type: "spki" })
    return nodeVerify(null, Buffer.from(digest), key, Buffer.from(signature, "base64"))
  } catch {
    return false
  }
}

// fingerprint is how a key is shown to a person. A full key is 44 characters of
// base64 that nobody compares; a short hash they might.
export function fingerprint(publicKey: string): string {
  const hash = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex")
  return hash.slice(0, 16).replace(/(.{4})(?=.)/g, "$1-")
}
