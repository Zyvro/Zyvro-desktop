# Zyvro Studio

A desktop workspace for Zyvro workflows: file tree, editor, shell, and an agent
chat, with the graph editor opening in a tab beside the code it acts on.

## Why it exists

Zyvro on the web runs workflows with the user's own API keys. That covers people
who have an API account, and misses most people who pay for AI: a ChatGPT Plus or
Claude subscription is not an API credential, and no hosted server can use one.

Codex makes this concrete. Its subscription mode authenticates against
`wss://chatgpt.com/backend-api`, not `api.openai.com`, and the access token in
`~/.codex/auth.json` is short-lived with a refresh token beside it. Pasting such
a token into a web app would stop working within the hour.

What does work is running the CLI the user already signed in to, on the machine
they signed in on. That is what this app is. `claude` and `codex` become text
providers, the engine runs locally, and no credential ever leaves the laptop.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ project name                          sidebar terminal agent │
├────┬──────────────┬─────────────────────────┬────────────────┤
│    │ Explorer     │ tabs                    │                │
│ ▤  │  src/        │  ┌───────────────────┐  │  Agent         │
│ ▣  │  package.json│  │ code  or  graph   │  │                │
│    │              │  └───────────────────┘  │  runs your own │
│    ├──────────────┤─────────────────────────┤  claude/codex  │
│    │ Workflows    │ Terminal                │  CLI here      │
│    │  Brain QA    │ $                       │                │
├────┴──────────────┴─────────────────────────┴────────────────┤
│ Local engine on port 51234   ✓claude ✓codex   3 workflows    │
└──────────────────────────────────────────────────────────────┘
```

Clicking a workflow opens the graph editor in a tab. It is not a reimplementation:
the renderer compiles `Zyvro-frontend/src/components/Builder.tsx` directly, in
`embedded` mode. A change to the editor lands in both products at once.

## The engine

The app ships `zyvrod` inside its own bundle and runs that one, and only that
one. A newer engine means a newer version of the app.

There used to be an update channel: the app asked `server.zyv.ro` for a newer
engine, checked an Ed25519 signature over a manifest, verified a SHA-256, and
ran what it had downloaded. All of it is gone.

It was careful machinery, and removing it is still the safer end state. The
engine runs with the user's full privileges, reads and writes their project and
holds their provider keys — it is the highest-value target in the product, and
the update channel was a second way to replace it, guarded by a key somebody had
to generate correctly, keep off the server, and never lose. Shipping the engine
with the build removes the channel, the key and the runtime download together.
The cost is that an engine fix rides on an app release, which for a desktop app
people already update is a small price.

Anything the old channel left in the user's folder is deleted at startup: those
binaries arrived over the network and were checked against a placeholder key, so
they do not get to sit there unused.

## The agent panel

The right-hand column runs the user's own `claude` or `codex` CLI in the project
directory, and hands it this project's Zyvro tools over MCP: list the workflows,
read a graph, run one, poll it, read the output. So "run the summarize workflow
and show me what it wrote" is a sentence it can act on, not just describe.

The tool surface and the tool names are the same ones the hosted product exposes
over MCP, served here by the local daemon and authenticated with the daemon's
own token. Claude gets it through a config file written with owner-only
permissions, Codex reads the token from an environment variable; neither puts it
in argv, where every process on the machine could read it.

Only the Zyvro tools are pre-approved, because a print-mode run cannot stop to
ask. The CLI's own file and shell tools keep whatever policy the user already
configured, and `--strict-mcp-config` keeps the user's other MCP servers out of
the panel.

## Reading and writing the project's files

Two node types exist only here, because they need a project folder on the
machine running the engine:

| Node | What it does |
|---|---|
| Read File | Reads a path in the project. An image becomes an image port, `.json` a json port, anything else text. |
| Write File | Writes its input to a path, and hands the same value straight back out, so a chain can keep going after the write. |

Paths are relative to the project folder and validated on both sides: the
picker refuses a file outside it, and the engine refuses one again at run time,
after resolving symlinks. Nothing may be written inside `.zyvro/`, so a
workflow cannot rewrite its own store or the secrets file.

They appear in the web app's palette too, marked Desktop. A hosted run
containing one is refused before any model call, with `code: "local_only_node"`
and a sentence saying where to open it instead. Seeing the node is how someone
finds out the desktop app can do this at all.

## Project format

Opening a folder creates `.zyvro/` inside it:

```
.zyvro/
  project.json          settings, including the default text provider
  workflows/<id>.json    one workflow per file, safe to commit
  runs/<execID>.json     execution records
  media/                 images produced by runs
  secrets.json           provider keys, mode 0600, gitignored
```

Workflows are files, so they version and review like the rest of the repository.

## Running it

This repository does not stand alone. The renderer compiles the web app's graph
editor straight from its source, and the local engine is built from the Go
backend, so both have to sit beside it under the same parent folder:

```
Zyvro/
├── Zyvro-engine/      https://github.com/Zyvro/Zyvro-engine    (Go, needs a Go toolchain)
├── Zyvro-frontend/    https://github.com/Zyvro/Zyvro-frontend  (the shared graph editor)
└── Zyvro-desktop/     this repository
```

```sh
git clone https://github.com/Zyvro/Zyvro-engine.git
git clone https://github.com/Zyvro/Zyvro-frontend.git
git clone https://github.com/Zyvro/Zyvro-desktop.git

cd Zyvro-frontend && npm install     # the renderer imports its components
cd ../Zyvro-desktop && npm install
npm run dev                          # builds the local engine, then starts the app
npm run dev -- ~/code/thing          # open a folder straight away
```

A packaged build needs none of this: the engine ships inside the app bundle.

`npm install` also builds `node-pty`. On macOS it fails against the SDK `xcrun`
selects by default, so `scripts/rebuild-native.mjs` retries against the Command
Line Tools SDK. If both fail the app still runs: the terminal falls back to a
PTY allocated through `script` on macOS and Linux, and to pipes on Windows.

Opening a folder:

| Where | How |
|---|---|
| Command line | `zyvro-studio ~/code/thing`, or `npm run dev -- ~/code/thing` |
| File menu | Open Folder, or Open Recent |
| Welcome tab | the Recent list, kept in the app's own data directory |

## The icon

`resources/` holds `icon.icns` (macOS), `icon.ico` (Windows) and `icon.png`
(Linux, and the window and dock icon during development). They are generated
and committed:

```sh
python3 scripts/make-icons.py     # needs Pillow, and iconutil for the .icns
```

The mark is not redrawn. It is composited from the web app's own
`public/brand/icon-512x512.png`, so the letterform stays the product's. What
changes is the ground: the web mark is a white Z on transparency, which
disappears against a light dock or taskbar, so the app icon puts it on a dark
tile. macOS gets a squircle inside transparent padding, Windows a tighter tile
that fills more of the canvas.

## Packaging

```sh
npm run pack:mac         # unpacked .app, for a quick check
npm run dist:mac         # signed dmg, arm64 + x64
npm run dist:win         # nsis installer, x64 + arm64
```

Each of those cross-compiles `zyvrod` for the target first, so a Windows
installer built on a Mac still contains a Windows engine. The binary ships in
`resources/bin` rather than inside the asar, because it has to be executable on
disk.

## Architecture notes

**One daemon per project.** `zyvrod` binds to `127.0.0.1` on a random port and
prints a JSON handshake with a bearer token that every `/api/` call must carry.
A second project window starts a second daemon, so two projects cannot see each
other's workflows.

**The renderer has no Node access.** `contextIsolation` is on, `nodeIntegration`
is off, and `src/preload/index.ts` is the entire surface: named operations only,
never a generic `invoke(channel, …)` passthrough. Filesystem calls resolve
through a single gate that rejects absolute paths, `..`, and symlink escapes.

**No `useEffect`.** The project bans it (`Zyvro-frontend/DOCTRINE-SANS-USEEFFECT.md`).
Server state is react-query, IPC streams are `useSyncExternalStore` over
module-level stores, imperative widgets (Monaco, xterm) attach through callback
refs on real nodes, and menu commands register once at import time.

**The shared API client is redirected, not forked.** `Zyvro-frontend/src/lib/api.ts`
reads its origin once at module load, and the daemon's port is only known at
runtime. `src/renderer/lib/daemon.ts` intercepts `fetch`, rewrites the build-time
placeholder to the live origin and attaches the token. The web app's code is
untouched.
