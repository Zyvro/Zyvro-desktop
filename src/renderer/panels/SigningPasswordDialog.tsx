import { useCallback, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { KeyRound } from "lucide-react"

// Publishing asks for the password again, and that is not an oversight.
//
// Signing in exchanged the password for an API key and forgot it, which is what
// makes a stolen laptop a smaller problem than it would otherwise be. The
// signing key is sealed with a key derived from the same password, so opening
// it means having the password in hand — and a key that could be opened without
// one would be a key anybody who reached this machine could publish with.
//
// It is asked once per sitting rather than once per pack: a person publishing a
// workflow and the three packs it calls should type it once, and the window
// forgets it when it closes.

export function SigningPasswordDialog({
  count,
  onCancel,
  onSubmit,
}: {
  count: number
  onCancel: () => void
  onSubmit: (password: string) => void
}) {
  const [password, setPassword] = useState("")
  const focusFirst = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
  }, [])

  const submit = () => {
    if (!password) return
    onSubmit(password)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="panel fixed left-1/2 top-1/3 z-50 w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            Sign {count === 1 ? "this pack" : `these ${count} packs`}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Everything you publish is signed, so whoever installs it can tell it is still coming from
            you. The signing key is encrypted with your password and we cannot open it — which is why
            it has to be typed here.
          </Dialog.Description>

          <label className="mt-4 block text-[11px] uppercase tracking-wide text-muted-foreground">
            Account password
          </label>
          <input
            ref={focusFirst}
            type="password"
            autoComplete="current-password"
            className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none focus:border-primary/50"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />

          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            The first publish from this account creates the key. It is sealed on this machine before
            it is stored, so publishing from a second machine works and a stolen database does not.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={!password}
              onClick={submit}
            >
              Sign and publish
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
