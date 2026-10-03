# Zyvro Studio 0.1.0-alpha.51

## What's new

- **Context recycle** — a recycle icon in the agent input shows how much of the model's window the conversation occupies. One click runs `/compact` on the harness, so a long task starts on a clean slate instead of hitting auto-compact halfway.
- **Shells stay closed** — opening a project no longer restores dead shells. Persistent sessions (tmux/screen) stay in the sidebar list only; you open them when you want them.
- **Collapsible sections** — Browser, Persistent shells and Workflows fold away, with a count badge so you can see whether anything is inside without opening them.
- **Full-height terminal** — the shell panel is no longer capped at 640 px; drag it wherever you want.
- **Field-of-view hint** — a faint outline marks the zone under the cursor (Editor, Terminal, Agent, Explorer…).

## Artifacts

| File | Size | SHA-256 |
|---|---|---|
| `Zyvro Studio-0.1.0-alpha.51-arm64.dmg` | 134.2 MB | `0ef48bb4c9b0640f86fafc5a8a1123416b80c17e7460fd9ff5d35aff2d745ff6` |
| `Zyvro Studio-0.1.0-alpha.51.dmg` | 141.0 MB | `f3c7bf36cdf49cd2a8d759cbba1cfe0927c37a060308cea1a61551e6b7b840b4` |

Windows (`Zyvro-Studio-Setup-0.1.0-alpha.51.exe`) is built by the release workflow on a Windows runner.

## Before you open it

**Nothing is signed for distribution.** That is a statement about this release, not a preference.

**macOS.** The app is ad-hoc signed and not notarized. Double-clicking it says the developer cannot be verified. Right-click → **Open**, or remove the quarantine flag:

```sh
xattr -dr com.apple.quarantine "/Applications/Zyvro Studio.app"
```

**Windows.** No Authenticode certificate, so SmartScreen shows "Windows protected your PC" on first run — **More info → Run anyway**.

Neither platform can tell you the download came from us rather than from someone who intercepted it. The SHA-256 above is the only integrity check available; it only helps if you check it.
