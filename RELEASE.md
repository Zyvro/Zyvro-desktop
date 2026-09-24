# Releasing Zyvro Studio

The process, and what it does not do. Read the second half before promising
anyone a smooth first launch.

## What a release contains

| Artifact | Platform | Built by |
|---|---|---|
| `Zyvro-Studio-<version>-arm64.dmg` | macOS, Apple Silicon | electron-builder |
| `Zyvro-Studio-<version>-x64.dmg` | macOS, Intel | electron-builder |
| `Zyvro-Studio-Setup-<version>.exe` | Windows x64 | electron-builder, nsis |

Each carries the local engine (`zyvrod`) for its own platform, cross-compiled
from the engine repository. The engine is a separate binary in
`Contents/Resources/bin`, not code inside the app bundle, because it has to be
executable on disk.

## Prerequisites

Three sibling checkouts, as `README.md` describes: `Zyvro-engine`,
`Zyvro-frontend` and this one. A Go toolchain for the engine, and Node for the
app. Nothing else: the release script builds what it needs.

## Cutting a release

```sh
npm run release -- 0.1.0-alpha.1
```

That single command:

1. refuses to run on a dirty tree, because a release built from uncommitted
   changes is a release nobody can reproduce
2. writes the version into `package.json`
3. cross-compiles the engine for `darwin-arm64`, `darwin-amd64` and
   `windows-amd64`, stamping each with the engine repository's git describe
4. builds the renderer and the main process
5. packages the three installers
6. prints the SHA-256 of each artifact

Publishing is deliberately a second, separate command, so the artifacts can be
looked at before they are public:

```sh
gh release create v0.1.0-alpha.1 --prerelease --title "..." --notes-file NOTES.md dist/*.dmg dist/*.exe
```

### Without pushing a tag

Some sessions can push a branch but not a tag. The Release workflow can then be
run by hand on that branch with `publish` checked: it builds the same three
installers, lets GitHub put the `v<version>` tag on the commit it built, and
publishes the release exactly as a pushed tag would.

## Version numbering

`MAJOR.MINOR.PATCH` with a pre-release suffix while the product is young:
`0.1.0-alpha.1`, `0.1.0-alpha.2`, then `0.1.0-beta.1`. The tag is the version
with a leading `v`.

The engine has its own version, stamped from its own repository. They are not
kept in step on purpose: the app updates its engine on its own schedule, and
pretending one number describes both would make that update look like a
downgrade.

## What is signed, and what happens to the person who downloads it

Nothing is signed for distribution. That is a statement about this release, not
a preference, and it is the first thing a user meets.

**macOS.** The only certificate on the build machine is an *Apple Development*
one. That kind signs builds for the machines on a developer's provisioning
profile; it does not satisfy Gatekeeper anywhere else, so signing with it would
add a step and change nothing. Distribution needs a *Developer ID Application*
certificate, which needs the paid Apple Developer Program, and then
notarization, which needs an Apple ID and an app-specific password.

So the app is ad-hoc signed, which is the minimum an Apple Silicon Mac needs to
run a binary at all, and it is not notarized. A user who double-clicks it is
told the developer cannot be verified. They can open it with a right-click and
**Open**, which offers the same dialog with a button that proceeds, or remove
the quarantine flag:

```sh
xattr -dr com.apple.quarantine "/Applications/Zyvro Studio.app"
```

Say this in the release notes. Finding out from a scary dialog is worse than
being told.

**Windows.** No Authenticode certificate, so SmartScreen shows "Windows
protected your PC" on first run, with **More info → Run anyway**. The warning
fades as an unsigned installer accumulates downloads, which is a reputation
system, not a fix. A certificate is the fix.

**What this means.** Neither platform can tell the user the download came from
us rather than from someone who intercepted it. Publishing the SHA-256 of every
artifact in the release notes is the only integrity check available, and it only
helps someone who checks it.

This is acceptable for an alpha aimed at people who were told where to look. It
is not acceptable for a public launch, and the two certificates are the work
between here and there.

## Checking a build before publishing

The release script prints hashes. Beyond that, on macOS:

```sh
codesign -dv --verbose=4 "dist/mac-arm64/Zyvro Studio.app" 2>&1 | head
spctl -a -vv "dist/mac-arm64/Zyvro Studio.app"     # expected to fail: not notarized
"dist/mac-arm64/Zyvro Studio.app/Contents/Resources/bin/zyvrod" --version
```

The last line matters most: an app whose engine does not run is an app that
opens a window and can do nothing.

## After publishing

The app checks `server.zyv.ro` for a newer *engine* and offers it; see
"Updating the engine" in `README.md`. The app itself has no updater, so a new
version of Zyvro Studio means asking people to download it again. That is fine
for an alpha and is the next thing to fix if the release cadence picks up.
