# Zyvro Studio

A desktop workspace for native coding agents: claude, codex, qwen and others
run in their own shells beside a file tree, an editor, git and a browser, and
keep their sessions from one launch to the next.

## Why it exists

A ChatGPT Plus or Claude subscription is not an API credential, and no hosted
server can use one.

Codex makes this concrete. Its subscription mode authenticates against
`wss://chatgpt.com/backend-api`, not `api.openai.com`, and the access token in
`~/.codex/auth.json` is short-lived with a refresh token beside it. Pasting such
a token into a web app would stop working within the hour.

What does work is running the CLI the user already signed in to, on the machine
they signed in on. That is what this app is: the agents are those CLIs, run in
their own interface, and no credential ever leaves the laptop.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ project name                          mode   sidebar   shell │
├────┬──────────────┬──────────────────────────┬─────────────┬─┤
│    │ Explorer     │ tabs                     │ Shell +     │▣│
│ ▤  │  src/        │  ┌────────────────────┐  │ Agents      │+│
│ ▣  │  package.json│  │ code               │  │ [claude][sh]│◈│
│    ├──────────────┤  └────────────────────┘  │ $           │ │
│    │ Agent sess.  │                          │             │◧│
│    │              │                          │             │ │
├────┴──────────────┴──────────────────────────┴─────────────┴─┤
│ Local engine on port 51234   ✓claude ✓codex                  │
└──────────────────────────────────────────────────────────────┘
```

**Two modes.** *Dev* is the code with the **Shell + Agents** panel beside it or
under it (the button at the top of the right-hand bar flips it; the choice is
remembered). *AI* is the Shell alone, taking the whole window; opening a file
steps it aside to its dock so you can read.

The thin bar on the far right holds new shell, run an agent, split, the dock
switch, the agent plugins that make sense without a chat (permission, skills,
the **task queue**, project memory, bug report, agent plugins) and the **project
logo**, at the bottom or the top of the bar (its menu changes the icon and moves
it). There is no separate chat column any more: the chat panel's code is still
in the repository but is not mounted.

The graph workflow editor, the workflows list, the store and the persistent
(tmux/screen) shells are gone: workflows live on the web app, and agents that
must outlive the window run in the terminal host instead (see below).

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

## The agent panel (no longer mounted)

The chat column described here has been replaced by [Shell + Agents](#shell--agents); its code is kept for now. It ran the user's own `claude` or `codex` CLI in the project
directory, and hands it this project's Zyvro tools over MCP, served by the
local daemon and authenticated with the daemon's own token. Claude gets it through a config file written with owner-only
permissions, Codex reads the token from an environment variable; neither puts it
in argv, where every process on the machine could read it.

Zyvro adds its MCP servers to the CLI's existing configuration, preserving the
user's servers, plugins and native skills. Claude's saved Chrome opt-in is
forwarded explicitly in print mode. Only Zyvro's MCP tools are pre-approved;
other tools remain subject to the selected permission mode and the CLI's rules.
The Advanced skills switch controls Zyvro's additional catalog, not native skills.

Type `/login` (or `/auth`) to sign in to the selected Claude, Codex, Qwen or
MiMo CLI in a dedicated integrated terminal. Finish the CLI's sign-in flow,
then return to the panel and send your message. The terminal and panel share
the CLI's normal credential store; login commands are never sent as model
prompts, queued behind a running turn, or rewritten by auto-synthesis.

Use **Find an agent session** in the panel header to search the current project's
conversations by name, harness or model, and filter to running agents. Rename a
started session with the pencil button or by double-clicking its tab. The command
palette also offers **New Agent Session**, **Find Agent Session**, **Focus Agent
Input**, and **Sign In to Agent**. Opening a session in the terminal creates a
dedicated tab and preserves its model and native session.

Questions and permission requests stay visible while an answer is being sent.
If delivery fails, the form keeps its entries and offers another attempt. Switching
projects preserves pending questions. Conversation writes are serialized per
project so agents finishing together cannot overwrite each other's history.

Stop ends the displayed turn immediately and terminates its process group,
including tools that ignore the first termination signal. A final Claude/Codex
result also ends the displayed turn even if the CLI takes time to shut down;
remaining teardown processes are stopped after a short grace period.

## Shell + Agents

The bottom panel is a shell **and** an agent launcher. An agent is a shell whose
program is the harness: `claude`, `codex`, `qwen` or `mimo` in its own native
interface, in a tab, with everything you configured translated into native
flags. The chat panel redraws the print-mode stream; this runs the real thing.

**Run one.** Open the launcher (the *Run an agent* bar, the bot menu next to `+`,
the bot button of the right-hand bar, or *View › New Agent Shell…*), pick the
harness, model and effort (or load a profile), and press **Empty**: the harness
opens in its own interface, on its own prompt, and you type the task there.
There is no task box in the launcher. Permission and skills are set once, in the
right-hand bar, and apply to the next agent you start:

**The bar's plugins talk to the agent you are using.** A plugin action (update
the project memory, an action of an installed or project plugin) is pasted into
the live agent that has focus and sent, exactly like a task from the queue; with
no live agent, it opens one with that request. The system prompt (project
memory, skills catalog, profile instructions) now reaches claude, codex and qwen
even when they start without a task; before, codex and qwen only got it
prefixed to a first task.

| Setting | What the harness receives |
|---|---|
| Harness, model | the binary, `--model` / `-m` (a local server model keeps its gateway route) |
| Permission (bar) | Read only → claude `plan`, codex `read-only`; Ask → it asks, on screen, in the terminal; Workspace → `acceptEdits` / `workspace-write`, nothing leaves the project; YOLO → everything lifted |
| Effort | `--effort` (claude), `model_reasoning_effort` (codex, capped at `high`) |
| Zyvro tools | the project's MCP servers (browser, capture), wired like a chat turn: a config file for claude and qwen, `-c` flags and an env token for codex, env for MiMo. Tokens never reach `ps` |
| Skills (bar) | the catalog of local skills, in the system prompt: `--append-system-prompt` for claude and qwen, `-c developer_instructions=…` for codex, ahead of the task for MiMo. Switching Skills on while an agent runs sends it the catalog as a message |
| Instructions (profile) | appended to the system prompt, or ahead of the task for harnesses without one |

When something does carry a task (a bar action such as *Update project memory*,
or *Ask agent to prepare this pack* in Settings), it is the last argument for
claude (after `--`: its variadic options would swallow it otherwise) and codex.
Qwen and MiMo have no prompt argument we could verify, so the task is pasted into
their prompt once they are ready, **without Enter**. A file sent to the agent
from the tree is typed into the active shell, quoted, without Enter. Plain
shells (`+`) are untouched, and both kinds live side by side, split and grouped
like any tab.

**Switch agent.** The arrows button of the tab bar (and the same icon on a row of
the *Agent sessions* list) reopens a session on another model or another harness
— something a harness does not do by itself, least of all from one provider to
another (Opus to an Ollama model, say). Within the same harness *Continue this
session* stops the agent and resumes the same conversation (`--resume`) with the
new model. *Hand over* works for any pair, because a session belongs to the
program that wrote it: Zyvro reads the old session's transcript (claude and
codex logs; the last exchanges, shortened to about 12,000 characters, plus the
original request), turns it into a briefing and starts a new agent with it as
its first message, telling it to check `git status` before touching anything.
Qwen and MiMo keep no log Zyvro can read, so a hand-over *from* them carries no
history, and *to* them the briefing is pasted for you to send with Enter.

**Task queue.** The clock button of the right-hand bar schedules prompts (now,
at a time, repeating). A task is typed into the agent shell it was added from —
pasted, then Enter — or into the agent on screen if that one is gone; with no
agent running, one opens with the launcher's settings and the task as its first
message. Tasks go one at a time, when every agent has been silent for six
seconds (an agent at work writes constantly, an idle one does not — a measure by
the output, not by the harness, so a long silent step can be mistaken for idle).

**Profiles** save a configuration under a name (*Save* in the launcher, or
Settings › Agents › Shell + Agents). The bot menu opens a profile straight onto
its prompt; each harness has one by default. A profile carries the harness, model, effort, instructions and Zyvro tools; the **permission and skills are never part of it** — they are the right-hand bar's, and apply to every agent you start, including one opened from a profile or the bot menu (which says which permission it will use). Each tab prints the permission flags it was started with.

**Sessions persist.** Every agent shell is recorded per project in the app's data
directory (`agent-shells/`), with its configuration and the harness's session id:
claude gets `--session-id <uuid>` up front, so it is known from the first second;
codex chooses its own id, which is read from its rollout log
(`~/.codex/sessions/…`, matched by folder, never shared between two tabs). When
Zyvro closes, every agent that was open comes back at the next launch (switchable
in Settings) with `--resume`, `codex resume`, the same permission and model. Closing a tab, or an agent that exits, keeps its session in the sidebar's
**Agent sessions** list, one click to resume, but it no longer reopens by itself.
A claude session where nothing was said yet has no log to resume, so it restarts
under the same id instead of failing. Qwen and MiMo do not tell us a new
session's id: they reopen a new conversation (use their own `/resume`), except
when opened from a chat thread that already has one.

**Agents keep running when Zyvro quits.** They do not run inside the app but in
a small background host (`src/main/ptyhost.ts`, started detached with
`ELECTRON_RUN_AS_NODE`, reached over a local socket guarded by a token). Quitting
or updating Zyvro only detaches from them; they keep working. At the next launch
Zyvro reattaches, the host replays their screen, and nothing has to be resumed.
Closing an agent's tab or switching its model still stops it. The model gateway
lives in the host too, at a stable address, so an agent aimed at a provider
through it keeps its model while Zyvro restarts. The project's MCP servers do
not: the engine restarts on a new port. Turn it off in Settings › Agents
(*Keep agents running when Zyvro quits*) to have agents stop with the app. Not on Windows yet: ConPTY started from the
detached host ended the agent at once on the Windows build machine, so there
agents still run inside the app.

The chat panel's *Open in terminal* button now opens this too: the thread's model,
the permission from the chat toolbar (no longer an implicit YOLO) and the
thread's session.

Run `npm run check:agent-shells` to verify the translation, the session store and
the wiring; it launches no model.

## The window, and what keeps it up

On macOS the native title bar is hidden and the three window buttons sit to the
**left** of the project tabs, centred in the 44 px bar (`shared/windowChrome` holds
the numbers; `npm run check:window` keeps the bar and the main process in step).
The window remembers its size, position, maximised and full-screen state between
launches (`window-state.json` in the app's data folder) and always puts itself back
on a screen that exists: unplug the monitor it was on and it comes back on the one
left, with its title bar within reach.

Things that used to be able to take the whole app down — and with it every shell and
agent — are contained: sending to a window that is closing, writing to or resizing a
shell whose process just died, a program that cannot be found, an uncaught exception
in a timer (noted in the bug-report log and absorbed; a burst of 25 in ten seconds
still stops the app). A renderer that crashes is reloaded (three times a minute at
most) and picks its shells up again; a render error shows a *Reload the window*
screen instead of a blank window.

**Terminal output.** Agent interfaces (Qwen Code, Claude Code, codex) redraw their
screen by erasing it line by line and rewriting it, and wrap each frame in
`ESC[?2026h … l` ("synchronized output") so a terminal paints only the finished
frame. xterm.js 5.5 does not know that mode and used to paint the half-erased
screen, which made all the text flicker like a strobe in Qwen Code. `SyncOutput`
(`shared/syncOutput`) holds each frame until it is complete and writes once per
animation frame; the main process also batches a shell's output into 4 ms groups.
`npm run check:terminal-output` covers it.

## Settings and advanced skills

Settings (`⌘,` / `Ctrl+,`) are grouped into General, Editor, Agents,
Permissions, Skills & packs, Appearance and Capture. Agent defaults select the
agent and its model for new chats; existing conversations retain their choices.
Permissions, prompt rewriting and usage display use the same preferences as the
chat toolbar. Existing settings files continue to load.

The **Skills** button enables automatic skill selection for a conversation. It
starts off in new chats. When enabled, Zyvro reads a fresh catalog before each
normal prompt and supplies names, descriptions and file paths. The agent chooses
relevant skills and reads their `SKILL.md` on demand. Native slash commands pass
through unchanged. The conversation remembers its Skills toggle.

The catalog scans the selected agent's project and user skill folders
(`.claude/skills`, `.codex/skills`, `.qwen/skills` or `.mimo/skills`), shared
`.agents/skills` folders, and packs downloaded by Studio. `CODEX_HOME` is honored.
This is a local file catalog, not an inventory of every plugin registered inside
every CLI. Skills and packs can be enabled individually in Settings; disabling
them affects Zyvro's automatic selection, not the CLI's independent discovery
or instructions already present in a conversation.

**Download gstack** and **Download pack** accept public GitHub repository URLs
(`https://github.com/owner/repository`). Git must be installed. Repositories are
cloned into the app's `skill-packs` directory, with the downloaded commit recorded.
Downloads are staged before appearing in the catalog and start inactive. Repeating
a download keeps the existing version; this first version does not auto-update
packs. Downloading does not execute setup scripts or call a model.

Some packs need more than Markdown. In particular, downloading gstack does not
build its browser tools or certify compatibility with a host. **Ask agent to
prepare this pack** puts an installation request into the chat composer to review
and send. **Ask agent for a pack** likewise starts a draft for a specific need.
Both use the ordinary agent permissions when the user sends the request.

Run `npm run check:skills` to verify discovery, opt-in pack activation, prompt
routing and downloads using local fixtures; it makes no network or model calls.

## Screen capture

An icon in the macOS menu bar or the Windows notification area captures an
area of the screen, or records up to a minute of it, and offers to copy it,
keep it, or publish it as a public link that lasts 24 hours. A recording is
published as WebM with a GIF beside it, made on the machine while it records.
It starts from a click or a shortcut only: no agent tool reaches it. See
[CAPTURE.md](CAPTURE.md).

## Project format

Opening a folder creates `.zyvro/` inside it:

```
.zyvro/
  project.json          settings, including the default text provider
  secrets.json           provider keys, mode 0600, gitignored
  plugins/<name>/        agent plugins this project is writing
```

## Running it

This repository does not stand alone. The renderer compiles a few of the web
app's components straight from its source (the provider keys panel, Markdown,
the shared API client), and the local engine is built from the Go backend, so
both have to sit beside it under the same parent folder:

```
Zyvro/
├── Zyvro-engine/      https://github.com/Zyvro/Zyvro-engine    (Go, needs a Go toolchain)
├── Zyvro-frontend/    https://github.com/Zyvro/Zyvro-frontend  (shared components)
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
other's providers or files.

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

## Installing desktop updates

On Windows, Zyvro waits for the update helper to initialize before closing. If
the helper cannot start, the app stays open and displays the error. Canceling
window closure leaves the update pending until the app actually quits. The
helper runs outside the installation folder, stops remaining Zyvro processes
from that installation, replaces the resources (or runs the full installer in
the same directory), and relaunches Zyvro. A failed resource swap restores the
previous version. Diagnostics are kept in the app's user-data `updates` folder:
`apply-bootstrap.log` for startup and `apply.log` for installation/relaunch.
Downloads also handle network and disk errors without crashing the app; incomplete
packages are removed. Preparing an update shows progress and blocks duplicate
installation requests across windows.

The next larger agent/project features are tracked in
[the agent workspace roadmap](features/agent-workspace-roadmap.md).
