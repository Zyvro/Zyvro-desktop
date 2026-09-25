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

## New in alpha.27

**Side-by-side editors (⌘\ / Ctrl+\).** View › Split Editor opens the current file in
a second group on the right. It is the same document on both sides, as in VS
Code: what you type on one side appears on the other, and there is a single set
of unsaved changes. Or drag a tab onto the right half of the editor. The right
group has its own tabs. Closing one there (its × or ⌘W) only closes that view;
the file stays open on the left. Drag the divider to resize (double-click resets
it). ⌘S, ⌘W, ⌘F, Go to Line and the status bar act on the side you last clicked,
which is marked by a blue line above its tabs.

## New in alpha.26

**Recent files.** File › Open Recent now lists the files you had open in this
project above the recent projects, as in VS Code, and Go to File (⌘P) offers them
as soon as it opens, even after a restart. Each project keeps its own list. A
deleted file drops off the list, and Clear Recently Opened empties both lists.

## New in alpha.25

**Drop any file from your desktop onto the window to open it**, as in Cursor and
VS Code, even when it is not in the project. It opens in its own tab, you can
edit it, and ⌘S saves it where it lives. Drop several files and each gets a tab.
A file that belongs to the open project opens in the same tab the file tree would
use. **File › Open File…** does the same from a dialog.

A binary file (or one too large, or in an encoding the editor does not read) is
not opened as text straight away, since saving it would damage it. The editor says
so, as Cursor does, and **Open Anyway** opens it regardless. Images still show as
images.

The window can only open files outside the project that you dropped on it or
chose in the dialog. Any other path on your disk is refused, even if something
asks for it by name.

## New in alpha.24

**Updates install themselves.** When a new version is out, click **Update** and
then **Restart to update**. Zyvro Studio closes, installs the new version in place
and opens again. There is no disk image to open and nothing to drag. Only the
part that changed is downloaded: the app's own code and engine, a fraction of the
full package, never Electron again unless Electron itself changed. Skipping
several versions still takes one download. If you cancel the quit because of
unsaved files, nothing is installed, and the update waits for the next time you
quit.

On a Mac this needs the app to be in a folder you can write to, such as
Applications. An app opened straight from Downloads runs from a read-only copy,
and there the disk image still opens as before. On Windows, when Electron changes,
the full installer runs silently in the background.

This version still installs the old way, one last time. From this version on,
updates apply themselves.

## New in alpha.23

**Format Document (⇧⌥F / Shift+Alt+F)** uses the editor's built-in formatters:
TypeScript, JavaScript, JSON, CSS, SCSS, Less and HTML. For other languages it
changes nothing. The new **Format on save** setting (Settings › Files) formats the
file when you save it yourself; auto save never rewrites what you are typing.

## New in alpha.22

**Type to search in the file tree.** With the tree focused, type the start of a
name to jump to it, as in Finder and VS Code. Press the same letter again to move
to the next name that starts with it.

## New in alpha.21

**Breadcrumbs above the editor.** The open file's path, one segment per folder,
with its file icon. Click a folder to open Go to File limited to that folder.

## New in alpha.20

**Problems (⇧⌘M / Ctrl+Shift+M).** The errors and warnings in your open files,
grouped by file, most serious first; click one to go to its line. A counter at the
bottom of the window shows how many there are, as in VS Code. Noise is kept out:
the editor sees one file at a time and not your `node_modules`, so "Cannot find
module" for every package import is left out, and the real mistakes stay visible.

**Go to Symbol in Editor (⇧⌘O / Ctrl+Shift+O)** lists the file's functions,
classes and variables to jump to, and **Go to Line (⌃G)** is in the Go menu and
the command palette.

**TypeScript understands JSX in `.tsx` files.** Each editor now knows the name of
its file, so a React component is no longer full of red underlines on every tag.

## New in alpha.19

**Select several files in the tree**, as in the Finder and VS Code: ⌘-click
(Ctrl-click on Windows) adds or removes one, Shift-click takes everything between.
Drag the selection to move it into a folder, onto the agent's message box, or
onto the terminal, which writes every path. Delete moves the whole selection to
the trash after one question. A plain click still opens a file; building up a
selection does not open ten tabs.

## New in alpha.18

**Zyvro Studio tells you when a newer version is out, and installs it.** A little
after it starts, and every few hours after that, the app asks GitHub for the
latest release. When there is a newer one, an **Update to …** badge appears at the
right of the status bar. It opens a dialog with the version, a link to what
changed, and a download button with a progress bar. The download is checked
against the SHA-256 published with the release, and a file that does not match
is deleted rather than installed. **File › Check for Updates…** asks straight
away. Automatic checks can be turned off in Settings.

Installing: on Windows the installer starts and the app closes so it can replace
its files. On a Mac the disk image opens; drag Zyvro Studio onto the copy in
Applications to replace it. The checksum proves the file arrived whole, not who
made it: the installers are still unsigned, so macOS and Windows warn about them,
as they did for the version you are running.

## New in alpha.17

**Open the agent in the terminal.** A new button at the top of the agent panel
starts the session's CLI (`claude`, `codex` or `qwen`) in the terminal, in its own
full-screen interface, and continues the same conversation you started in the
panel. The terminal opens if it was hidden.

**Clear the terminal** with ⌘K on a Mac, as in Terminal.app and VS Code, or with
**Clear Terminal** from the command palette. Ctrl+K elsewhere is left to the
shell, which uses it to delete to the end of the line.

## Fixed in alpha.17

- **Shells you closed came back.** Closing a restored shell did not remove it
  from what the project reopens, so hiding and showing the terminal, or quitting
  and relaunching, brought it back. Closing a shell with its × now removes it
  for good.
- **Quitting sometimes lost the shells you wanted back, or kept old ones.** The
  shells were saved twice on quit, and whichever write finished last won,
  sometimes an empty list. They are now saved once, and before the app exits.
- **A shell opened in a subfolder was not saved**, and a restored shell's
  history disappeared at the second reopening. Both are kept now.
- **Sending something to a hidden terminal did nothing**: "Open in terminal"
  from the file tree, for example. The text now waits for the shell to start.

## New in alpha.16

**Markdown preview (⇧⌘V / Ctrl+Shift+V)**, as in VS Code, or the **Preview**
button at the top right of any Markdown file. It opens in its own tab and follows
what you type, before you save. The same shortcut takes you back to the text.
HTML inside a Markdown file is shown as text, never run, so a README from
somewhere else cannot put anything into the window.

## New in alpha.15

**Git in the editor's margin.** As in VS Code, the gutter beside the line numbers
shows what changed since the last commit: a green bar for added lines, a blue
bar for modified ones, and a small red triangle where lines were deleted. The
same marks appear along the scrollbar, so you can find your changes in a long
file. They follow your typing and refresh after a commit or a checkout. It works
when the project is a subfolder of a larger repository, and it stays out of Git
Output, which remains a log of what you ran.

## New in alpha.14

**Click a file path in the terminal to open it at that line.** Compiler errors,
failing tests and stack traces all say where to look: `src/app.ts:12:5`,
`src/app.ts(12,5)`, Python's `File "app/main.py", line 12`, the absolute paths
in a Node stack trace. They are now links, underlined when you point at them,
that open the file in the editor with the cursor on the line and column. Only
paths that name a real file in the project become links, so `e.g.` or `v1.2.3`
stay plain text, and web addresses still open in your browser.

## New in alpha.13

**Settings (⌘, / Ctrl+,).** Font size, tab size, spaces or tabs, whether to
follow a file's own indentation, word wrap, the minimap, line numbers (including
relative), and whitespace rendering. Every change applies to the open editors
straight away. They are kept on this computer; a font size is not something you
commit. The page also links to Providers and API keys.

**Auto save**, off by default as in VS Code: after a delay you choose, or when
the editor loses focus (another tab, another panel, another application).

## New in alpha.12

**An icon for every kind of file**, as in VS Code and Cursor: the TypeScript,
React, Go, Python or Docker logo, a green `package.json`, a flask for a test file,
and folders drawn after what they hold (`src`, `components`, `tests`, `docs`,
`.github`). They are in the file tree, on the editor tabs and in Go to File.

The icons are [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)'s,
the most installed icon theme for both editors, used under its MIT license; the
notice ships with the app in `THIRD-PARTY-NOTICES.md`.

## New in alpha.11

**Git in the file tree.** Changed files are colored and carry their letter at the
right, as in VS Code: **M** modified, **U** untracked, **A** added, **D** deleted,
and conflicts in their own color. A folder that contains changes gets a dot in
the most serious color among them, so you can see where you have been working
without unfolding everything or opening the Git panel. It works when the project
is a subfolder of a larger repository too.

**Tabs behave like VS Code's.** A file you only looked at opens as a preview,
in italics, and the next file you open replaces it. Double-click the tab (or the
file in the tree) to keep it. Editing a file keeps it too, even after you save;
before, a saved file went back to being a preview and the next click in the
tree replaced it. **Drag a tab** to reorder the tab bar.

## New in alpha.10

**The file tree follows what you are looking at.** Open a file from Go to File,
from a search result or from the agent, and the tree unfolds down to it and
points at it, as in VS Code. **Collapse Folders** (the new button in the tree's
header) folds everything back.

**The file tree works from the keyboard.** Click in it, then: up and down move
between rows; right opens a folder, then steps into it; left closes a folder, or
goes up to the parent; Enter opens a file or toggles a folder; **F2** renames;
**Delete** (or ⌘⌫ on a Mac) moves to the trash, after asking.

Moving a file to the trash also closes its tab, unless the tab has unsaved
changes: those stay open, since that text now exists nowhere else.

## New in alpha.9

**Command Palette (⇧⌘P / Ctrl+Shift+P).** Every command in the app's menus, one
fuzzy search away, with its shortcut beside it: type `>` and a few letters
(`>togterm` for Toggle Terminal, `>zoom` for the zoom levels). It is the same
box as Go to File, as in VS Code: delete the `>` to search files instead.

The palette reads the menu itself rather than keeping its own list, so a command
and its shortcut are only ever written in one place.

**The editor in the status bar.** The cursor's line and column (and how much is
selected), the indentation, the line endings and the language of the file in
front of you, at the right of the status bar, as in VS Code. Each one is a
button: the position opens Go to Line, `LF`/`CRLF` switches the file's line
endings, and the indentation lets you choose spaces or tabs and their width.

**Right-click a tab** for Close, Close Others, Close to the Right, Close All,
Copy Path, Copy Relative Path, and Reveal in Finder (File Explorer on Windows).
Closing several modified files asks once for all of them, not once per file.

**A file you edit back to what is saved is no longer "modified".** Type a
character and delete it, or undo all the way: the dot on the tab goes away, as in
VS Code, and closing it no longer asks about changes that are not there.

## New in alpha.8

Drag and drop, the way VS Code and Cursor do it.

- **Drop files and folders from the Finder or Windows Explorer onto the file
  tree** to copy them into the project. Drop on a folder to put them inside it,
  on a file to put them beside it, or on the empty space to put them at the
  root. Nothing is ever overwritten: a name that is taken gets a free one
  (`notes 2.txt`), and the originals stay where they were.
- **Drag a file or folder inside the tree to move it.** Hold Alt (Option on a
  Mac) to copy instead. A collapsed folder opens when you hover over it, so you
  can drop three levels down without letting go. A folder cannot be dropped
  into itself; the tree does not light up when you try.
- **Open tabs follow the file.** Moving or renaming a file that is open in a tab
  keeps the tab, with its unsaved changes. Before, the next save would have
  written the old path back to disk.
- **Drop a folder on the window to open it as the project.** If a project is
  already open, the app asks first and says how many unsaved files would be
  lost.
- **Drop a file from the project onto the editor to open it in a tab.**

**Go to File (⌘P / Ctrl+P).** Type a few letters of a file's name and press
Enter, like in VS Code: `edarea` finds `EditorArea.tsx`, `pan/term` finds
`panels/TerminalPanel.tsx`. With nothing typed it lists your open and recently
closed files. Add `:42` (or `:42:7`) to jump to a line, which is what you copy
from a stack trace.

## Fixed in alpha.8

Four ways to lose work without being asked.

- **⌘S (Ctrl+S) saved every open file, not just the one in front of you.** Every
  editor listened to the menu's Save, and hidden tabs stay mounted, so a file
  opened an hour ago was written back over whatever had changed it since. Save
  now writes the active tab only. **Save All** is its own command, ⌘⌥S
  (Ctrl+Alt+S).
- **Closing a modified tab threw the changes away.** It now asks: Save, Don't
  Save, or Cancel. If saving fails (a full disk, a read-only file), the tab
  stays open with its changes.
- **Closing the window or quitting with unsaved files lost them.** The app now
  asks first, with Save All, Don't Save and Cancel.
- **⌘W closed the whole window**, with the project, its shells and the running
  agent. ⌘W (Ctrl+W) now closes the editor tab, as in every editor. Closing the
  window moves to ⌘⇧W (Ctrl+Shift+W).

Also new: **Reopen Closed Editor** (⌘⇧T / Ctrl+Shift+T) and middle-click to
close a tab.

The Windows installer is back. alpha.7 has none: a test used a fake engine that
Windows cannot start, and the Windows build stopped there.

## New in alpha.6

**A browser, inside the IDE, that the agent drives.** A page with its own
session, in a panel beside the code — so an agent checking its work never
touches the browser where you are signed in to everything. It opens a URL,
reads what is on the page, clicks, types, waits for text to appear, scrolls,
runs an expression, reads the console and the failed requests, and takes a
screenshot. Several pages at once, each named, each with its favicon in the
sidebar.

Right-click and **Inspect**, and Chromium's own developer tools open *under the
page*, on the element you pointed at: Elements with the live DOM, Console,
Network, Application with its cookies and its storage. Not an imitation and not
a second window to lose behind the others — the app is Chromium, so these are
its own tools.

**The agent can write, and you say how much.** Four levels, next to the
message box: read-only, ask before each change, the whole workspace, or
everything. *Ask* shows a card naming the tool and what it would do, with
Allow and Deny — the agent waits for you instead of stalling. The choice is
remembered per project, so a folder you set to one level opens at that level
next time, and the default is the whole workspace: an agent that cannot write
in the project you opened for it is an agent you have to argue with.

**Any agent you start in the terminal gets this project's tools.** Type
`claude` or `codex` in the shell and it comes up already knowing this project's
workflows, because the shell hands it the MCP servers on the way in. The port
and the token change at every start; nobody should have to go looking for them.

**Search and replace, across the project or inside one file.** ⇧⌘F searches
every file in the folder — plain text, whole word, or a regular expression with
`$1` in the replacement — narrowed by the usual globs. Replace one occurrence,
all of them in one file, or all of them everywhere; the button says how many and
in how many files before you touch it. ⌘F stays in the file you are reading. What
gets replaced is what you were shown: each passage is checked against the file
again, and one that moved since the search is skipped rather than overwritten.
Arrow-up in the search box brings back what you searched before.

**Photograph a panel, and hand it to someone.** Click the camera, then the panel
you mean: the app knows where its own panels are, so the image stops at their
edges instead of a rectangle you dragged by hand, and the selection frame is not
in the picture. Then it asks what to do with it — keep it here, or upload it to
your Zyvro account and copy a public link.

**Suggestions in the editor, off until you turn them on.** Grey text at the
cursor, from a model of your choosing, and completing code is treated as its own
job rather than a flavour of text generation: it has its own list of providers,
because a chat model answers a sentence where the editor wants three characters.
A model on your own machine is usually the right one.

**Video nodes.** Text to video, on Veo through the Gemini API or on FLUX 3 Video
at Black Forest Labs, with an image on the input to open the shot. Resolution and
duration are settings on the node rather than a hidden default, because video is
the one thing here billed by the second and the price per second climbs with the
resolution. What one backend cannot do it refuses by name — Veo has no QHD step —
rather than quietly rendering something smaller than you asked for at the price
you asked for.

**Runtime inputs are named where you can see them.** The editor says which nodes
a run can fill by name, so a workflow you drive from the API or from an MCP tool
tells you what it expects instead of failing on a key nobody wrote down.

## Fixed in alpha.6

**The developer tools opened empty.** Elements, Console, Network — the right
panel, all eight tabs, and nothing in any of them. Electron does not bridge its
inspector to a `<webview>`, so the tools were connected to nothing at all. They
are drawn in a native view now, which is the documented path and the one that
works.

**A screenshot photographed its own overlay.** The selection frame and "Click a
panel · Esc to cancel" were in the image: the overlay was dismissed and the
capture taken in the same tick, before the screen had been redrawn.

**And then it left a hole where the devtools were.** `capturePage` renders a
window's HTML, and a native view is drawn on top of it rather than inside — so
photographing the browser panel with the tools open produced a picture that
looked normal and was empty exactly where you wanted to look. The capture now
composes the native views back in.

**Errors arrived with their plumbing.** "Error invoking remote method
'shots:share': Error: Sign in to publish to the store." The sentence was written
to be read; the wrapper in front of it named a channel nobody needs to know, and
made a clear instruction look like a crash.

**A cached run could replay the wrong result.** A workflow driven by node id
rather than by input name folded the old value into its fingerprint, so a second
run with a different input was answered from the cache.

**A Black Forest Labs key you had pasted never reached a run.** The panel said
"Connected" — it reads what is stored — and the run said no key was configured,
because the step that folds a stored key into a run's configuration did not name
this one. Both statements were true and nothing connected them. Image nodes on
your own FLUX key were affected too; only the platform's key, which arrives by
another road, ever worked.

**Smaller things.** The shell greeted you in French in an English app. The agent's
message box overflowed its panel and left no room to type. Store thumbnails were
drawn by a copy of the web app's component instead of the component.

## New in alpha.5

**Models that never leave your machine.** Ollama on this computer, LM Studio,
and any other server speaking the OpenAI chat API are providers now, for text
generation and for vision. They are configured by an address rather than by a
key, so the panel asks for one and fetches the model list from the server
itself — what is installed is your business and changes whenever you pull
something new. Asking a question about an image is the call where sending it
away is the whole cost, and a model on your own machine is the only way not to.

The same for images: any server speaking the OpenAI images API can back an
image node, generation and editing both. Editing used to be Gemini's alone on
the reasoning that it had no equivalent elsewhere. It has.

**Providers are grouped by what they do.** Image generation, vision and text
generation are three headings rather than two, because a provider that draws an
image cannot always read one — and when you have more than one for a job, you
say which is tried first.

**The agent panel.** Several agents at once, each in its own tab with its own
session; the session survives closing the app, so a conversation picks up where
it stopped. A model picker that shows the default it would have used. Images
you attach are handed to the CLI, which can actually open them. And what the
agent is doing is shown as it does it — the file it is reading, the command it
is running — rather than a spinner until it finishes.

**Workflows move between projects.** Import from another project on this
machine, share one by private link, and find everything you have put online
under *My workflows*.

**Images in the chat.** Paste, drop or pick one, and ask about it.

## Fixed in alpha.5

**Every image a run produced showed as broken.** The app loads media from the
engine it started, on a port it only learns at launch, and the address being
built still carried the placeholder port — so generated images, workflow
thumbnails and chat attachments all pointed at nothing. A resolver for exactly
this existed and had no callers: every component used the shared one, which is
the point of sharing them. There is one function now, and a check in the build
that asserts the address it produces is the live port.

**Runs were sent to a backend you never configured.** Each router ended with a
fixed name, so somebody running LM Studio and holding no key at all was told to
go and get a key for a service they had never asked for. A rule that names
something usable is still obeyed; one that names something unusable now gives
way to what you actually have. Two things it was hiding: an installed `claude`
CLI was quietly elected as the default text backend — spending your
subscription because a binary exists is your decision, not ours — and every
install claimed to have an Ollama, because the default address was being counted
as a credential.

## Fixed in alpha.4

**The agent could not find `claude` or `codex`.** Installed from the `.dmg` and
launched from the Finder, the app reported the CLI you use every day as "not on
your PATH" — true, and useless: it was on yours, and the app could not see it.

macOS launches an app from the Finder through launchd, which reads no shell
profile at all: no `.zshrc`, no `.zprofile`. The process starts with the system
default PATH, and everything a package manager or version manager installed is
missing from it. These two CLIs commonly live in `~/.local/bin`, which is
nowhere in that list.

The app now asks your login shell what its PATH is and adopts it, and when a
tool is still missing it asks `npm` and `brew` where they put things rather than
guessing. On Windows it also looks for the extension, because the thing called
`claude` there is `claude.cmd`, which cannot be started without a command
interpreter.

This survived every test for one reason worth admitting: the app was always
launched from a terminal during development, where it inherited the right PATH.
The check that covers it now reproduces the Finder's environment instead.

## New since alpha.1

**Source control.** A Git panel laid out the way editors lay it out: the message
box above the button, staged and unstaged in their own groups, the status letter
in the right-hand column, and the actions on the row you are pointing at. It
talks to the `git` on your machine rather than to a reimplementation, so what it
shows and what a terminal in the same folder shows cannot disagree. Stage,
unstage, discard, commit, branch, stash, tag, remotes, pull, push, and a
side-by-side diff on any changed file. `Show Git Output` keeps every command and
what git said back, which is the honest answer when something fails for a reason
no panel could have phrased.

**Generate a commit message.** A button in the message box reads the staged diff
and writes a subject line, using the `claude` or `codex` already installed on
your machine — one-shot, no tools, no MCP. Nothing goes to a server of ours and
there is no key to add. If neither CLI is installed, the button is not there.

**Two modes.** *Dev* is an editor: tabs, a shell underneath, the agent beside
you. *AI* is the agent: it takes the middle, there is no shell, and nothing is
open. Opening a file is what says you want to read it yourself, so that is when
the agent steps aside to the right.

**Signed packs.** A publisher's key is generated on their own machine and stored
only sealed under their password, which never reaches the server. Installing
verifies the signature, writes the key down the first time, and refuses the day
it changes — the same bargain SSH makes with host keys, and for the same reason.

**A free daily allowance** on the hosted store: ten image runs and ten model
calls a day per account, so a workflow you copy runs before you have added any
credential of your own.

## What is in it

- The graph editor from the web app, hosted in an editor tab
- Read File and Write File nodes that act on the open project
- An agent panel running your own CLI, with this project's Zyvro tools over MCP
- Git, with a diff view, in a panel beside the file tree
- Node packs written in Lua, sandboxed: no filesystem, no network, no processes,
  with a deadline, a memory ceiling and a model-call budget
- A store for nodes and workflows, where installing a workflow pulls the nodes
  it needs

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
