import { useCallback, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
} from "lucide-react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import type { Change, GitStatus } from "../../preload"
import { gitActions, useGitAction, useGitStatus } from "~/lib/git"
import { useWorkspace } from "~/state/workspace"
import { askName } from "~/state/prompt"
import { GitMenu } from "~/panels/GitMenu"

// Source control, laid out the way VS Code lays it out, because that layout is
// what everybody who will open this window already knows: the message box above
// the button, the groups below it, the status letter in the right-hand column,
// and the actions on the row you are pointing at rather than in a menu.
//
// Following it is not deference. Every one of those choices answers a question
// this panel would otherwise have to answer again, and answering them
// differently would cost the person the thing they already have — knowing where
// to look without reading anything.

function basename(p: string): string {
  const parts = p.split("/")
  return parts[parts.length - 1] || p
}

function dirname(p: string): string {
  const parts = p.split("/")
  parts.pop()
  return parts.join("/")
}

// The status letter is coloured the way git's own porcelain is read: green for
// something arriving, yellow for something changed, red for something leaving.
const LETTER_TINT: Record<string, string> = {
  A: "text-emerald-400",
  U: "text-emerald-400",
  M: "text-amber-400",
  T: "text-amber-400",
  R: "text-sky-400",
  C: "text-sky-400",
  D: "text-red-400",
}

function Letter({ change }: { change: Change }) {
  const letter = change.status === "conflicted" ? "!" : change.letter
  return (
    <span
      title={change.status}
      className={cn("ml-auto shrink-0 pl-2 font-mono text-[11px] font-semibold", LETTER_TINT[letter] ?? "text-red-400")}
    >
      {letter}
    </span>
  )
}

type RowAction = { icon: typeof Plus; label: string; onClick: () => void }

function Row({ change, actions, onOpen }: { change: Change; actions: RowAction[]; onOpen: () => void }) {
  const dir = dirname(change.from && change.status === "renamed" ? change.path : change.path)
  return (
    <div className="group flex items-center gap-1.5 rounded-md px-2 py-[3px] hover:bg-white/[0.06]">
      <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={onOpen} title={change.path}>
        <span className="truncate text-[13px] leading-5">{basename(change.path)}</span>
        {dir && <span className="truncate text-[11px] text-muted-foreground">{dir}</span>}
        {change.from && change.status === "renamed" && (
          <span className="truncate text-[11px] text-muted-foreground">← {basename(change.from)}</span>
        )}
      </button>
      {/* The actions appear on the row being pointed at, so a long list is a
          list of names rather than a wall of buttons. */}
      <span className="ml-auto flex shrink-0 items-center opacity-0 group-hover:opacity-100">
        {actions.map(({ icon: Icon, label, onClick }) => (
          <button
            key={label}
            title={label}
            className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
            onClick={onClick}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </span>
      <Letter change={change} />
    </div>
  )
}

function Group({
  title,
  changes,
  actions,
  rowActions,
  onOpen,
}: {
  title: string
  changes: Change[]
  actions: RowAction[]
  rowActions: (change: Change) => RowAction[]
  onOpen: (change: Change) => void
}) {
  const [open, setOpen] = useState(true)
  if (changes.length === 0) return null
  return (
    <section className="mt-1">
      <div className="group flex items-center gap-1 px-1">
        <button className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left" onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="truncate text-[13px] font-medium">{title}</span>
        </button>
        <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
          {actions.map(({ icon: Icon, label, onClick }) => (
            <button
              key={label}
              title={label}
              className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
              onClick={onClick}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </span>
        <span className="ml-1 shrink-0 rounded-full bg-white/[0.09] px-1.5 text-[11px] text-muted-foreground">
          {changes.length}
        </span>
      </div>
      {open && (
        <div className="pl-1">
          {changes.map((change) => (
            <Row
              key={`${change.staged ? "s" : "w"}:${change.path}`}
              change={change}
              actions={rowActions(change)}
              onOpen={() => onOpen(change)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// The state a folder is in before anybody has run git init. VS Code answers it
// with an offer rather than an error, which is right: it is not a failure, it
// is every project's first minute.
function NotARepository({ onInit, busy }: { onInit: () => void; busy: boolean }) {
  return (
    <div className="space-y-3 p-3 text-[13px] leading-relaxed text-muted-foreground">
      <p>
        The folder currently open doesn&apos;t have a Git repository. You can initialize a repository
        which will enable source control features.
      </p>
      <button
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        disabled={busy}
        onClick={onInit}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 zy-spin" />}
        Initialize Repository
      </button>
      <p className="text-[12px]">
        Everything happens with the git on this machine, so the repository is an ordinary one: the
        terminal below, and any other tool you use, see exactly the same thing.
      </p>
    </div>
  )
}

// fit keeps the box exactly as tall as its text, up to the max-height the class
// sets. Written against the element rather than held in state: the height is a
// fact about the DOM node, and mirroring it into React would mean a render per
// keystroke to say something the browser already knows.
//
// An empty box is left to CSS, at one row. Measuring it would grow it instead:
// a textarea's scrollHeight counts the placeholder, and this placeholder —
// `Message (⌘⏎ to commit on "…")` — wraps onto two lines in a panel this
// narrow, so an empty box measured itself at 52px. That is why VS Code shows
// that text clipped rather than wrapped: the box is one line, and the sentence
// is longer than the box.
function fit(node: HTMLTextAreaElement): void {
  if (node.value === "") {
    node.style.height = ""
    return
  }
  node.style.height = "auto"
  node.style.height = `${node.scrollHeight}px`
}

// The generator, using the agent already installed on this machine — the same
// claude or codex the person runs in their terminal. Nothing leaves for a
// server of ours and there is no key to add. If neither is installed the button
// is not rendered at all, rather than offered and then failing.
function SuggestButton({ onMessage }: { onMessage: (message: string) => void }) {
  const agent = useQuery({
    queryKey: ["git", "agent"],
    queryFn: () => window.zyvro.git.agent(),
    staleTime: Infinity,
  })
  const suggest = useMutation({
    mutationFn: () => window.zyvro.git.suggestMessage(),
    onSuccess: (text) => onMessage(text),
  })

  if (!agent.data) return null

  return (
    <button
      className="absolute right-1 top-1 rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-50"
      title={
        suggest.isError
          ? (suggest.error as Error).message
          : `Generate a commit message from the diff, with ${agent.data}`
      }
      disabled={suggest.isPending}
      onClick={() => suggest.mutate()}
    >
      {suggest.isPending ? <Loader2 className="h-3.5 w-3.5 zy-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
    </button>
  )
}

function CommitBox({ status }: { status: GitStatus }) {
  const [message, setMessage] = useState("")
  // The box is resized when it is handed to us and again on every keystroke.
  // A callback ref is the mount half of that, and it is what this project uses
  // in place of an effect.
  const boxRef = useRef<HTMLTextAreaElement | null>(null)
  const grow = useCallback((node: HTMLTextAreaElement | null) => {
    boxRef.current = node
    if (node) fit(node)
  }, [])

  // A generated message arrives from outside the keystroke path, so it has to
  // resize the box itself; otherwise a three-line suggestion lands in a
  // one-line box and reads as truncated.
  const setAndFit = useCallback((text: string) => {
    setMessage(text)
    if (boxRef.current) {
      boxRef.current.value = text
      fit(boxRef.current)
    }
  }, [])
  const commit = useGitAction(gitActions.commit)
  const push = useGitAction(gitActions.push)

  const staged = status.staged.length
  const nothingStaged = staged === 0
  const blocked = status.conflicts.length > 0

  const run = async (andPush: boolean) => {
    if (!message.trim() || blocked) return
    // Nothing staged means commit what is there, which is what ⌘⏎ does in VS
    // Code and what `git commit -a` does in a terminal. Naming it stageAll
    // rather than doing it silently is the difference between a shortcut and a
    // surprise.
    await commit.mutateAsync({ message, options: { stageAll: nothingStaged } })
    setMessage("")
    if (andPush) await push.mutateAsync(undefined)
  }

  const busy = commit.isPending || push.isPending
  const label = status.branch ? `Message (⌘⏎ to commit on "${status.branch}")` : "Message"

  return (
    <div className="space-y-2 px-2 pb-2">
      {/* One line to start with, growing with what is typed. A box that opens
          three lines tall asks for a paragraph, and most commits are a
          sentence; it is also three lines of the panel not showing files. */}
      <div className="relative">
        <textarea
          ref={grow}
          rows={1}
          className="zy-scroll max-h-40 w-full resize-none overflow-y-auto rounded-md border border-white/[0.08] bg-white/[0.03] py-[6px] pl-2 pr-8 text-[13px] leading-5 outline-none placeholder:text-muted-foreground focus:border-primary/50"
          placeholder={label}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value)
            fit(event.currentTarget)
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              void run(false)
            }
          }}
        />
        <SuggestButton onMessage={setAndFit} />
      </div>
      <div className="flex">
        <button
          className="flex flex-1 items-center justify-center gap-1.5 rounded-l-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={busy || !message.trim() || blocked}
          onClick={() => void run(false)}
          title={
            blocked
              ? "Resolve the conflicts first"
              : nothingStaged
                ? "Nothing is staged, so every change will be committed"
                : `Commit ${staged} staged change${staged === 1 ? "" : "s"}`
          }
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 zy-spin" /> : <Check className="h-3.5 w-3.5" />}
          Commit
        </button>
        <button
          className="rounded-r-md border-l border-black/20 bg-primary px-2 py-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={busy || !message.trim() || blocked || status.remotes.length === 0}
          title="Commit and push"
          onClick={() => void run(true)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {(commit.isError || push.isError) && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[12px] text-destructive">
          {((commit.error ?? push.error) as Error).message}
        </p>
      )}
    </div>
  )
}

export function GitPanel() {
  const project = useWorkspace((s) => s.project)
  const openDiff = useWorkspace((s) => s.openDiff)
  const status = useGitStatus()
  const init = useGitAction(gitActions.init)
  const stage = useGitAction(gitActions.stage)
  const unstage = useGitAction(gitActions.unstage)
  const discard = useGitAction(gitActions.discard)
  const branch = useGitAction(gitActions.createBranch)

  if (!project) {
    return <p className="p-3 text-[12px] text-muted-foreground">Open a project to use source control.</p>
  }
  if (status.isLoading && !status.data) {
    return (
      <p className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 zy-spin" /> Reading the repository
      </p>
    )
  }
  if (status.isError) {
    return (
      <p className="m-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive">
        {(status.error as Error).message}
      </p>
    )
  }
  if (!status.data?.repository) {
    return (
      <>
        <NotARepository onInit={() => init.mutate(undefined)} busy={init.isPending} />
        {init.isError && (
          <p className="mx-3 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive">
            {(init.error as Error).message}
          </p>
        )}
      </>
    )
  }

  const repo = status.data
  const discardWith = async (paths: string[], what: string) => {
    // The only irreversible thing in this panel, so it is the only one that
    // asks. Typing the word is deliberate: a dialog you dismiss with Enter is a
    // dialog that does not slow anybody down, which is the whole point here.
    const confirmed = await askName({
      title: `Discard changes to ${what}?`,
      label: "This throws the changes away and git cannot bring them back. Type discard to confirm.",
      confirmLabel: "Discard",
    })
    if (confirmed?.trim().toLowerCase() === "discard") discard.mutate(paths)
  }

  const allUnstaged = repo.unstaged.map((c) => c.path)
  const allStaged = repo.staged.map((c) => c.path)

  return (
    <div className="zy-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-1 px-2 pt-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5" />
          <span className="truncate">{repo.branch ?? `detached at ${repo.head}`}</span>
          {repo.ahead > 0 && <span title={`${repo.ahead} to push`}>↑{repo.ahead}</span>}
          {repo.behind > 0 && <span title={`${repo.behind} to pull`}>↓{repo.behind}</span>}
        </span>
        <button
          title="New branch"
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          onClick={async () => {
            const name = await askName({ title: "New branch", label: "Branch name", confirmLabel: "Create" })
            if (name?.trim()) branch.mutate(name.trim())
          }}
        >
          <GitBranch className="h-3.5 w-3.5" />
        </button>
        <button
          title="Refresh"
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
          onClick={() => void status.refetch()}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", status.isFetching && "zy-spin")} />
        </button>
        <GitMenu status={repo} />
      </div>

      <CommitBox status={repo} />

      {/* Conflicts first, and on their own, because they are the only group you
          cannot clear by clicking a plus, and anything below them is waiting on
          them anyway. */}
      <Group
        title="Merge Changes"
        changes={repo.conflicts}
        actions={[]}
        rowActions={(change) => [
          { icon: Plus, label: "Stage as resolved", onClick: () => stage.mutate([change.path]) },
        ]}
        onOpen={(change) => openDiff(change.path, false)}
      />

      <Group
        title="Staged Changes"
        changes={repo.staged}
        actions={[{ icon: Minus, label: "Unstage all", onClick: () => unstage.mutate(allStaged) }]}
        rowActions={(change) => [
          { icon: Minus, label: "Unstage", onClick: () => unstage.mutate([change.path]) },
        ]}
        onOpen={(change) => openDiff(change.path, true)}
      />

      <Group
        title="Changes"
        changes={repo.unstaged}
        actions={[
          { icon: Undo2, label: "Discard all", onClick: () => void discardWith(allUnstaged, "every change") },
          { icon: Plus, label: "Stage all", onClick: () => stage.mutate(allUnstaged) },
        ]}
        rowActions={(change) => [
          { icon: Undo2, label: "Discard", onClick: () => void discardWith([change.path], basename(change.path)) },
          { icon: Plus, label: "Stage", onClick: () => stage.mutate([change.path]) },
        ]}
        onOpen={(change) => openDiff(change.path, false)}
      />

      {repo.staged.length + repo.unstaged.length + repo.conflicts.length === 0 && (
        <p className="p-3 text-[12px] text-muted-foreground">No changes.</p>
      )}

      {[stage, unstage, discard, branch].some((m) => m.isError) && (
        <p className="m-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive">
          {(([stage, unstage, discard, branch].find((m) => m.isError)?.error as Error) ?? new Error("")).message}
        </p>
      )}
    </div>
  )
}
