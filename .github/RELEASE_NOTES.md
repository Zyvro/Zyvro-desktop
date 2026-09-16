Zyvro Studio is a desktop workspace for Zyvro workflows: a file tree, an editor,
a terminal, and an agent panel, with the graph editor opening in a tab beside
the code it acts on.

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

**macOS.** The app is not notarized, so macOS says the developer cannot be
verified. Right-click the app and choose **Open**, which offers the same dialog
with a button that proceeds. Or:

```sh
xattr -dr com.apple.quarantine "/Applications/Zyvro Studio.app"
```

**Windows.** The installer is not signed, so SmartScreen shows "Windows
protected your PC". Choose **More info**, then **Run anyway**.

Both warnings are accurate: neither platform can tell you this download came
from us rather than from someone who intercepted it. The SHA-256 of every file
is in the build summary, and checking it is the only verification available
until the certificates are in place.

## What is in it

- The graph editor from the web app, hosted in an editor tab
- Read File and Write File nodes that act on the open project
- An agent panel running your own CLI, with this project's Zyvro tools over MCP
- Node packs written in Lua, sandboxed: no filesystem, no network, no processes,
  with a deadline, a memory ceiling and a model-call budget
- A store for nodes and workflows, where installing a workflow pulls the nodes
  it needs

## Known limits

- Image nodes need a Google AI Studio key; there is no CLI path for them
- The app has no self-updater. The engine updates itself, the app does not.
- Nothing in the store is reviewed, and packs are not signed. Read a pack's Lua
  before installing it; the app puts that one click from the listing.
