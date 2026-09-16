import * as Menu from "@radix-ui/react-dropdown-menu"
import { ChevronRight, MoreHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import type { GitStatus } from "../../preload"
import { askName } from "~/state/prompt"
import { useWorkspace } from "~/state/workspace"
import { gitActions, useGitAction } from "~/lib/git"

// The overflow menu, with the same contents and the same order as the one in
// VS Code and Cursor: the three things you reach for constantly at the top —
// Pull, Push, Fetch — then Clone and Checkout to…, then everything else folded
// into submenus.
//
// The order is the point. Push was reachable before this only as the chevron
// beside Commit, which meant a repository whose commits were already made had
// no way to send them: the button was disabled because the message box was
// empty. Nobody would guess that, and nobody should have to.

const item =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-[13px] outline-none data-[highlighted]:bg-white/[0.09] data-[disabled]:opacity-40"
const panel =
  "panel z-50 min-w-[190px] p-1 shadow-[0_8px_32px_rgba(0,0,0,0.6)]"

function Item({
  children,
  onSelect,
  disabled,
  title,
}: {
  children: React.ReactNode
  onSelect: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <Menu.Item className={item} disabled={disabled} title={title} onSelect={onSelect}>
      {children}
    </Menu.Item>
  )
}

function Sub({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger className={cn(item, "justify-between")}>
        {label}
        <ChevronRight className="h-3.5 w-3.5 opacity-60" />
      </Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent className={panel} sideOffset={4}>
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  )
}

const separator = <Menu.Separator className="my-1 h-px bg-white/[0.08]" />

export function GitMenu({ status }: { status: GitStatus }) {
  const openGitOutput = useWorkspace((s) => s.openGitOutput)
  const run = useGitAction(async (task: () => Promise<unknown>) => task())

  const has = status.remotes.length > 0
  const go = (task: () => Promise<unknown>) => () => run.mutate(task)

  // ask wraps the prompt so a cancelled dialog is simply nothing happening,
  // rather than a command run with an empty name.
  const ask = async (title: string, label: string, confirmLabel = "OK") =>
    (await askName({ title, label, confirmLabel }))?.trim() ?? ""

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          title="More actions"
          className="rounded p-1 text-muted-foreground outline-none hover:bg-white/[0.08] hover:text-foreground data-[state=open]:bg-white/[0.08]"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className={panel} align="end" sideOffset={4}>
            <Item onSelect={go(gitActions.pull)} disabled={!has} title={has ? "" : "No remote"}>
              Pull
            </Item>
            <Item onSelect={go(gitActions.push)} disabled={!has} title={has ? "" : "No remote"}>
              Push
            </Item>
            <Item
              onSelect={async () => {
                const url = await ask("Clone a repository", "Repository URL", "Clone")
                if (url) run.mutate(() => window.zyvro.git.clone(url))
              }}
            >
              Clone
            </Item>
            <Item
              onSelect={async () => {
                const name = await ask("Checkout to…", "Branch name", "Checkout")
                if (name) run.mutate(() => gitActions.checkout(name))
              }}
            >
              Checkout to…
            </Item>
            <Item onSelect={go(gitActions.fetch)} disabled={!has}>
              Fetch
            </Item>

            {separator}

            <Sub label="Commit">
              <Item
                onSelect={async () => {
                  const message = await ask("Amend the last commit", "New message", "Amend")
                  if (message) run.mutate(() => window.zyvro.git.commit(message, { amend: true }))
                }}
                disabled={status.unborn}
              >
                Amend Last Commit…
              </Item>
              <Item
                onSelect={async () => {
                  const message = await ask("Commit all changes", "Message", "Commit")
                  if (message) run.mutate(() => window.zyvro.git.commit(message, { stageAll: true }))
                }}
              >
                Commit All…
              </Item>
            </Sub>

            <Sub label="Changes">
              <Item
                onSelect={go(() => gitActions.stage(status.unstaged.map((c) => c.path)))}
                disabled={status.unstaged.length === 0}
              >
                Stage All Changes
              </Item>
              <Item
                onSelect={go(() => gitActions.unstage(status.staged.map((c) => c.path)))}
                disabled={status.staged.length === 0}
              >
                Unstage All Changes
              </Item>
            </Sub>

            <Sub label="Pull, Push">
              <Item onSelect={go(gitActions.pull)} disabled={!has}>
                Pull
              </Item>
              <Item onSelect={go(gitActions.push)} disabled={!has}>
                Push
              </Item>
              {status.remotes.map((remote) => (
                <Item key={remote} onSelect={go(() => window.zyvro.git.pushTo(remote, true))}>
                  Push to {remote}…
                </Item>
              ))}
              <Item onSelect={go(gitActions.fetch)} disabled={!has}>
                Fetch
              </Item>
              <Item onSelect={go(() => window.zyvro.git.pushTags())} disabled={!has}>
                Push Tags
              </Item>
            </Sub>

            <Sub label="Branch">
              <Item
                onSelect={async () => {
                  const name = await ask("New branch", "Branch name", "Create")
                  if (name) run.mutate(() => gitActions.createBranch(name))
                }}
              >
                Create Branch…
              </Item>
              <Item
                onSelect={async () => {
                  if (!status.branch) return
                  const name = await ask(`Rename "${status.branch}"`, "New name", "Rename")
                  if (name) run.mutate(() => window.zyvro.git.renameBranch(status.branch as string, name))
                }}
                disabled={!status.branch}
              >
                Rename Branch…
              </Item>
              <Item
                onSelect={async () => {
                  const name = await ask("Delete branch", "Branch name", "Delete")
                  if (name) run.mutate(() => window.zyvro.git.deleteBranch(name, false))
                }}
              >
                Delete Branch…
              </Item>
            </Sub>

            <Sub label="Remote">
              <Item
                onSelect={async () => {
                  const url = await ask("Add remote", "Repository URL", "Add")
                  if (!url) return
                  const name = (await ask("Add remote", "Name for this remote", "Add")) || "origin"
                  run.mutate(() => window.zyvro.git.addRemote(name, url))
                }}
              >
                Add Remote…
              </Item>
              {status.remotes.map((remote) => (
                <Item key={remote} onSelect={go(() => window.zyvro.git.removeRemote(remote))}>
                  Remove {remote}
                </Item>
              ))}
            </Sub>

            <Sub label="Stash">
              <Item
                onSelect={async () => {
                  const message = await ask("Stash changes", "Optional message", "Stash")
                  // Untracked files go with it. Leaving them behind is git's
                  // default and it surprises everybody exactly once: you stash,
                  // your new file is still there, and you decide stashing is
                  // broken.
                  run.mutate(() => window.zyvro.git.stash(message, true))
                }}
                disabled={status.staged.length + status.unstaged.length === 0}
              >
                Stash Changes…
              </Item>
              <Item onSelect={go(() => window.zyvro.git.stashPop(0))}>Pop Latest Stash</Item>
              <Item onSelect={go(() => window.zyvro.git.stashApply(0))}>Apply Latest Stash</Item>
              <Item onSelect={go(() => window.zyvro.git.stashDrop(0))}>Drop Latest Stash</Item>
            </Sub>

            <Sub label="Tags">
              <Item
                onSelect={async () => {
                  const name = await ask("New tag", "Tag name", "Create")
                  if (!name) return
                  const message = await ask("New tag", "Optional message (makes it annotated)", "Create")
                  run.mutate(() => window.zyvro.git.createTag(name, message))
                }}
                disabled={status.unborn}
              >
                Create Tag…
              </Item>
              <Item
                onSelect={async () => {
                  const name = await ask("Delete tag", "Tag name", "Delete")
                  if (name) run.mutate(() => window.zyvro.git.deleteTag(name))
                }}
              >
                Delete Tag…
              </Item>
            </Sub>

            {separator}

            <Item onSelect={() => openGitOutput()}>Show Git Output</Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {run.isError && (
        <span
          className="max-w-[9rem] truncate text-[11px] text-destructive"
          title={(run.error as Error).message}
        >
          {(run.error as Error).message}
        </span>
      )}
    </>
  )
}
