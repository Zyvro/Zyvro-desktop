// A signature is worth exactly as much as the agreement between the side that
// makes it and the side that checks it, and here those are two languages: the
// desktop signs in Node, the server verifies in Go, and every client that ever
// installs a pack verifies in Node again.
//
// Nothing in a type system can hold that agreement. What holds it is a vector
// the Go side produced — a fixed key, a fixed digest, a fixed signature — and
// the requirement that this implementation accept it. Produced with
// crypto/ed25519 from a seed of 0x00..0x1f so anyone can regenerate it:
//
//     seed[i] = byte(i); priv := ed25519.NewKeyFromSeed(seed)
//     sig := ed25519.Sign(priv, []byte(digest))
//
// It pins more than the algorithm. It pins that the public key travels as the
// bare 32 bytes rather than a DER wrapper, that the signature is base64, and
// that what gets signed is the digest's ASCII text and not the bytes it
// encodes — three decisions that are invisible in the code and fatal to get
// wrong, because a mismatch does not crash: it refuses every pack.
//
//     node scripts/check-signing.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-signing-check")
mkdirSync(dir, { recursive: true })

const entry = path.join(dir, "harness.ts")
writeFileSync(
  entry,
  `export { generateIdentity, signDigest, verifyDigest, fingerprint } from "${path
    .join(ROOT, "src/main/signing")
    .replace(/\\/g, "/")}"\n`
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

const { generateIdentity, signDigest, verifyDigest, fingerprint } = createRequire(import.meta.url)(outfile)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- the cross-language vector -------------------------------------------

const DIGEST = "eb9a11099dacc0baa824d0867e23cafc7234d5e881624371ce5852298adc17f6"
const GO_PUBLIC = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="
const GO_SIGNATURE =
  "36U/ookBgH8DbBHO0t2rZAi8xO7Hs5CECWDhd2wqZVLh5o8DvnXKH43It5LqB/4fUtc6179YFjSpDkKaOnmWBw=="

check("accepts a signature made by the Go implementation", verifyDigest(DIGEST, GO_SIGNATURE, GO_PUBLIC))
check(
  "refuses that signature on a different digest",
  !verifyDigest(DIGEST.replace(/^eb/, "ec"), GO_SIGNATURE, GO_PUBLIC)
)
check(
  "refuses a signature against a key that did not make it",
  !verifyDigest(DIGEST, GO_SIGNATURE, Buffer.alloc(32, 7).toString("base64"))
)
check("refuses a public key that is not 32 bytes", !verifyDigest(DIGEST, GO_SIGNATURE, Buffer.alloc(31).toString("base64")))
check("refuses rubbish instead of throwing", !verifyDigest(DIGEST, "not base64 at all", GO_PUBLIC))

// ---- what this side produces ---------------------------------------------

const params = { kdf_version: 1, kdf_iterations: 600000, kdf_salt: "zyvro-auth-v1:someone@example.com" }
const identity = await generateIdentity("correct horse battery staple", params)

check("a generated public key is 32 bytes", Buffer.from(identity.publicKey, "base64").length === 32)
check("the sealed private key is not the private key", !identity.wrappedPrivateKey.includes(identity.publicKey))
check("the identity records which derivation sealed it", identity.kdfVersion === params.kdf_version)

const signature = await signDigest(DIGEST, identity, "correct horse battery staple", params)
check("a signature this side makes verifies with its own key", verifyDigest(DIGEST, signature, identity.publicKey))
check("it does not verify against the Go vector's key", !verifyDigest(DIGEST, signature, GO_PUBLIC))
check("it does not verify on another digest", !verifyDigest(DIGEST.replace(/f6$/, "f7"), signature, identity.publicKey))

// The whole reason the key is sealed rather than stored: the password is the
// only thing that opens it, so the wrong one has to fail closed.
let refused = false
try {
  await signDigest(DIGEST, identity, "correct horse battery stapl", params)
} catch (err) {
  refused = /does not open this signing key/.test(err.message)
}
check("a wrong password does not open the key", refused)

// Sealing twice must not produce the same bytes: the nonce is drawn fresh, and
// a reused AES-GCM nonce under one key is the failure that leaks plaintext.
const second = await generateIdentity("correct horse battery staple", params)
check("two seals of the same kind differ", second.wrappedPrivateKey !== identity.wrappedPrivateKey)

// A fingerprint is what a person compares, so it has to be a function of the
// key alone and short enough that they will.
check("a fingerprint is stable for a key", fingerprint(GO_PUBLIC) === fingerprint(GO_PUBLIC))
check("a fingerprint distinguishes two keys", fingerprint(GO_PUBLIC) !== fingerprint(identity.publicKey))
check("a fingerprint is readable", /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(fingerprint(GO_PUBLIC)), fingerprint(GO_PUBLIC))

console.log(failures === 0 ? "\nSigning agrees with the server." : `\n${failures} check(s) failed.`)
rmSync(dir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
