// Ad-hoc signs the packaged macOS app.
//
// electron-builder's `identity: null` does not mean "sign with nothing"; it
// means "skip signing", and what it leaves behind on arm64 is worse than
// unsigned: a signature that declares resources it never wrote. macOS refuses
// to launch it, and the failure is silent — the process starts and exits with
// no dialog and nothing in the log.
//
// An Apple Silicon binary needs a signature to run at all, so the app is
// ad-hoc signed here, which is the minimum that actually works. It still is
// not notarized, and RELEASE.md says what that means for whoever downloads it.
const { spawnSync } = require("node:child_process")
const path = require("node:path")

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  // --deep is deprecated for distribution signing and exactly right here: an
  // ad-hoc signature has no identity to propagate, and every nested framework
  // and helper needs one of its own.
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  })
  if (sign.status !== 0) throw new Error(`Ad-hoc signing failed for ${app}`)

  // Verify rather than assume. The whole reason this file exists is that a
  // signature can be present and still not let the app start.
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", app], {
    encoding: "utf8",
  })
  if (verify.status !== 0) {
    throw new Error(`Ad-hoc signature does not verify: ${verify.stderr.trim()}`)
  }
  console.log(`  • ad-hoc signed and verified  ${path.basename(app)}`)
}
