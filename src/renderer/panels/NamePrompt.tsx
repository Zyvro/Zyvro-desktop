import { useCallback, useState, useSyncExternalStore } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { cn } from "@/lib/utils"
import { getPending, settle, subscribe } from "~/state/prompt"

// The replacement for window.prompt. It renders whatever the module store has
// pending, which is what lets the File menu ask for a name without a component
// having to be mounted and listening.

export function NamePrompt() {
  const pending = useSyncExternalStore(subscribe, getPending, getPending)
  // Remounting on each request is deliberate: it resets the input to the new
  // initial value without an effect watching for the request to change.
  return pending ? <PromptDialog key={pending.title + pending.initial + pending.kind} /> : null
}

function PromptDialog() {
  const pending = getPending()
  const [value, setValue] = useState(pending?.initial ?? "")

  // A callback ref on the input is both simpler and more reliable than reaching
  // into the dialog from a focus event: the node is handed to us the moment it
  // exists, which is exactly when it can be focused.
  const focusInput = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
    node?.select()
  }, [])

  // Une question sans champ n'a rien à mettre au premier plan que sa réponse.
  const focusConfirm = useCallback((node: HTMLButtonElement | null) => {
    node?.focus()
  }, [])

  if (!pending) return null

  const asking = pending.kind === "confirm"
  const submit = () => {
    if (asking) {
      settle("yes")
      return
    }
    const trimmed = value.trim()
    if (trimmed) settle(trimmed)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && settle(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="panel fixed left-1/2 top-1/3 z-50 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 p-5"
          // Radix focuses the dialog container by default; the input is what
          // the user came here to type in.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="text-sm font-semibold">{pending.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] text-muted-foreground">
            {pending.label}
          </Dialog.Description>

          {!asking && (
          <input
            ref={focusInput}
            className="mt-3 h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none focus:border-primary/50"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submit()
              }
            }}
          />
          )}

          <div className="mt-4 flex justify-end gap-2">
            {pending.alternativeLabel && (
              <button
                className="mr-auto rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                onClick={() => settle("alternative")}
              >
                {pending.alternativeLabel}
              </button>
            )}
            <button
              className="rounded-lg border border-white/[0.1] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              onClick={() => settle(null)}
            >
              Cancel
            </button>
            <button
              ref={asking ? focusConfirm : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 text-[13px] font-medium disabled:opacity-50",
                pending.danger
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              )}
              disabled={!asking && value.trim() === ""}
              onClick={submit}
            >
              {pending.confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
