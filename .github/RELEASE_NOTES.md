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
- The app has no self-updater, and the engine now ships inside it rather than
  updating separately: a new engine means a new app
- Nothing in the store is reviewed. Packs are signed now, but a signature says
  who published something, not that it is safe — read a pack's Lua before
  installing it; the app puts that one click from the listing
- Publish to GitHub is not in the Git panel, and neither is an interactive
  rebase or merge: `pull` is fast-forward only rather than leaving a repository
  half-way through something this panel cannot finish
