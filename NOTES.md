Zyvro Studio is a desktop workspace for Zyvro workflows: a file tree, an editor,
a terminal, source control, and an agent panel, with the graph editor opening in
a tab beside the code it acts on.

**This is an alpha.** It is built from three public repositories, it is not
signed, and the parts that touch a store are new. Read the two warnings below
before the first launch.

## Why it exists

A ChatGPT or Claude subscription is not an API credential, and no hosted server
can use one. But the `claude` and `codex` command line tools on your own machine
are already signed in, so Zyvro Studio runs them as text providers. Your
subscription drives a workflow, and no credential ever reaches Zyvro.

Everything runs locally. Workflows live as files under `.zyvro/` in the folder
you open, so they version alongside your code. The only traffic that leaves your
machine is the model call itself, and it goes straight to the provider.

## First launch

**macOS.** Take the `.dmg` for your machine — `arm64` for Apple Silicon, the
other for Intel — open it and drag the app to Applications. A `.zip` of the same
build is there too, for anyone who would rather not mount an image.

alpha.2 shipped without a `.dmg` at all, on a note in the build workflow saying
`hdiutil` failed on the build machines. It does not; the run that note came from
had already failed for an unrelated reason, and the last error in the log was
read as the cause. The `.dmg` is back.

The app is ad-hoc signed but not notarized, so macOS says the developer cannot
be verified: right-click it and choose
**Open**, which offers the same dialog with a button that proceeds. Or:

```sh
xattr -dr com.apple.quarantine "/Applications/Zyvro Studio.app"
```

**Windows.** The installer is not signed, so SmartScreen shows "Windows
protected your PC". Choose **More info**, then **Run anyway**.

Both warnings are accurate: neither platform can tell you this download came
from us rather than from someone who intercepted it. Every file's SHA-256 is at
the bottom of this page, and checking it is the only verification available
until the certificates are in place.

```sh
shasum -a 256 ~/Downloads/Zyvro*        # macOS
certutil -hashfile Zyvro*.exe SHA256    # Windows
```

## What is in it

- Large number of fix

## Known limits

- Image nodes need a Google AI Studio or Black Forest Labs key once the free
  daily allowance is spent
- Video nodes need one of those two keys from the start: there is no free
  allowance for video, and both backends bill by the second
- The app has no self-updater, and the engine now ships inside it rather than
  updating separately: a new engine means a new app
- Nothing in the store is reviewed. Packs are signed now, but a signature says
  who published something, not that it is safe — read a pack's Lua before
  installing it; the app puts that one click from the listing
- Publish to GitHub is not in the Git panel, and neither is an interactive
  rebase or merge: `pull` is fast-forward only rather than leaving a repository
  half-way through something this panel cannot finish

## Checksums

| File | Size | SHA-256 |
|---|---|---|
| `Zyvro Studio-0.1.0-alpha.7-arm64.dmg` | 134.4 MB | `7c4812c590598e6abdc2b1564b31ded8ed215579d69754ce04e75aa27c8b1d0a` |
| `Zyvro Studio-0.1.0-alpha.7.dmg` | 141.2 MB | `9e6a0c66bbec206d18feeb587bdf366771e15bae4f8ed725b2c29835caaa1828` |
