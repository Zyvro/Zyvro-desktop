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

**macOS.** The download is a zip. Unzip it in Finder, or with `ditto -x -k`,
and move the app to Applications. The app is ad-hoc signed but not notarized,
so macOS says the developer cannot be verified: right-click it and choose
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
- The app has no self-updater, and the engine now ships inside it rather than
  updating separately: a new engine means a new app
- Nothing in the store is reviewed. Packs are signed now, but a signature says
  who published something, not that it is safe — read a pack's Lua before
  installing it; the app puts that one click from the listing
- Publish to GitHub is not in the Git panel, and neither is an interactive
  rebase or merge: `pull` is fast-forward only rather than leaving a repository
  half-way through something this panel cannot finish
