import { useCallback, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { Loader2 } from "lucide-react"
import { useSignIn } from "~/lib/account"

// Signing in exchanges the password for an API key and forgets the password.
// The exchange happens in the main process, so what is typed here leaves this
// window immediately and is never stored anywhere.

export function SignInDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const signIn = useSignIn()

  const focusFirst = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
  }, [])

  const submit = () => {
    if (!email.trim() || !password) return
    signIn.mutate({ email: email.trim(), password }, { onSuccess: onClose })
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="panel fixed left-1/2 top-1/3 z-50 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-sm font-semibold">Sign in to Zyvro</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Only needed to publish. Browsing and installing work signed out.
          </Dialog.Description>

          <label className="mt-4 block text-[11px] uppercase tracking-wide text-muted-foreground">
            Email
          </label>
          <input
            ref={focusFirst}
            type="email"
            autoComplete="username"
            className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none focus:border-primary/50"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />

          <label className="mt-3 block text-[11px] uppercase tracking-wide text-muted-foreground">
            Password
          </label>
          <input
            type="password"
            autoComplete="current-password"
            className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none focus:border-primary/50"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />

          {signIn.isError && (
            <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
              {(signIn.error as Error).message}
            </p>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Your password is exchanged for an API key and not kept. You can revoke that key from your
            account page at any time.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={signIn.isPending || !email.trim() || !password}
              onClick={submit}
            >
              {signIn.isPending && <Loader2 className="h-3.5 w-3.5 zy-spin" />}
              Sign in
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
