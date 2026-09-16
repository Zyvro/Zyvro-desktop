// Two clients derive the same key from the same password, and they must agree
// byte for byte. If they ever stop, nobody sees a crash: the server is simply
// told the wrong password, and people are locked out of their own accounts with
// a message that says their password is wrong.
//
// So both implementations are run against one another and against a vector
// pinned here. The vector is the important half: two files can drift together,
// and a number typed wrong in both would pass a comparison and fail every
// login.
//
// This repository is the only place that has both — it compiles the frontend's
// source and ships its own.
//
//     node scripts/check-kdf.mjs
import { build } from "esbuild"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const WEB = path.resolve(ROOT, "../Zyvro-frontend/src/lib/kdf.ts")
if (!existsSync(WEB)) {
  console.log("skipped: the frontend is not next to this repo")
  process.exit(0)
}

const dir = path.join(ROOT, "node_modules", ".zyvro-kdf-check")
mkdirSync(dir, { recursive: true })
const entry = path.join(dir, "harness.ts")
writeFileSync(
  entry,
  `export { deriveAuthHash as desktop } from "${path.join(ROOT, "src/main/kdf").replace(/\\/g, "/")}"\n` +
    `export { deriveAuthHash as web } from "${WEB.replace(/\\.ts$/, "").replace(/\\/g, "/")}"\n`
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

// The browser build calls btoa; Node has it under another name.
globalThis.btoa ??= (s) => Buffer.from(s, "binary").toString("base64")
const { desktop, web } = createRequire(import.meta.url)(outfile)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Computed with a third implementation — Python's hashlib, which shares no code
// with either client — rather than copied from the output of what is being
// checked. A vector taken from the code under test proves only that the code
// equals itself.
//
// Changing the salt, the iteration count or the second derivation changes this
// value, which is the point: such a change locks out every existing account, so
// it should take editing this line to do it.
//
//   master = pbkdf2_hmac("sha256", password, salt, 600000, 32)
//   hash   = b64(pbkdf2_hmac("sha256", master, password, 1, 32))
const VECTOR = {
  password: "correct horse battery staple",
  params: { kdf_version: 1, kdf_iterations: 600000, kdf_salt: "zyvro-auth-v1:someone@example.com" },
  expected: "T6vezulLXNbvkVduW2kEyAdOs1xnU94K0jT7yrIVX6U=",
}

const fromDesktop = await desktop(VECTOR.password, VECTOR.params)
const fromWeb = await web(VECTOR.password, VECTOR.params)

check("the desktop and the web app derive the same hash", fromDesktop === fromWeb, `${fromDesktop}\n        ${fromWeb}`)
check("the derivation still matches the pinned vector", fromDesktop === VECTOR.expected, `got ${fromDesktop}`)

// A different password must not land on the same hash, which would mean the
// password is not reaching the derivation at all.
const other = await desktop("something else", VECTOR.params)
check("a different password derives differently", other !== fromDesktop)

// The salt is per account, so two accounts with one password must differ.
const otherSalt = await desktop(VECTOR.password, { ...VECTOR.params, kdf_salt: "zyvro-auth-v1:other@example.com" })
check("two accounts with the same password derive differently", otherSalt !== fromDesktop)

console.log(failures === 0 ? "\nBoth clients derive the same key." : `\n${failures} check(s) failed.`)
rmSync(dir, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
