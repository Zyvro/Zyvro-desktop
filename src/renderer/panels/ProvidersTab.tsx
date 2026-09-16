import { Terminal as TerminalIcon } from "lucide-react"
import { ProviderKeys } from "@/components/ProviderKeys"

// Same provider panel as the web app. The difference worth saying out loud is
// at the top: on this machine there is a way to run a workflow that needs no
// key at all, because the CLI the user already signed in to carries their
// subscription.

export function ProvidersTab() {
  return (
    <div className="zy-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <h1 className="text-xl font-semibold">Providers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workflows run on your own accounts. Nothing here is sent to zyv.ro.
        </p>

        <div className="panel mt-6 flex gap-3 p-4">
          <TerminalIcon className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
          <div className="text-[13px] leading-relaxed">
            <p className="font-medium text-foreground">Using a subscription instead of an API key</p>
            <p className="mt-1 text-muted-foreground">
              Set a text node&apos;s provider to <span className="text-foreground">Claude CLI</span> or{" "}
              <span className="text-foreground">Codex CLI</span> and it runs through the command line
              tool installed on this machine. Sign in once in the terminal below, with{" "}
              <code className="rounded bg-white/[0.06] px-1 py-0.5">claude</code> or{" "}
              <code className="rounded bg-white/[0.06] px-1 py-0.5">codex login</code>, and a ChatGPT or
              Claude subscription works with no key to paste. This only works here, in the desktop app,
              because the sign-in lives on your machine.
            </p>
          </div>
        </div>

        <div className="mt-6">
          <ProviderKeys />
        </div>
      </div>
    </div>
  )
}
