import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { CommitOptions } from "../../preload"
import { useWorkspace } from "~/state/workspace"

// The one key every git query and mutation shares, so any change refreshes the
// panel, the status bar and an open diff together. Three views of one
// repository that disagree about what is staged are worse than one.
export const gitKey = ["git"] as const

// Polled rather than watched. Git is not the only thing that writes to a
// repository: the terminal beside this window is, and so is whatever the person
// has open elsewhere. A panel that only refreshed after its own buttons would
// be wrong the moment somebody typed `git add` two panes over, and being
// quietly wrong about what is staged is the failure worth avoiding here.
//
// `git status` with GIT_OPTIONAL_LOCKS=0 does not touch the index lock, so this
// cannot interrupt a command running in that terminal.
//
// react-query stops the interval while the window is in the background, which
// is the behaviour to want: polling a window nobody is looking at spends
// battery to learn something nobody is reading. refetchOnWindowFocus is what
// covers the gap — coming back to the window is exactly when the answer has to
// be right, and it is also exactly when the person has just finished doing
// something to the repository somewhere else.
const POLL_MS = 3000

export function useGitStatus(enabled = true) {
  const project = useWorkspace((s) => s.project)
  return useQuery({
    queryKey: [...gitKey, "status", project?.project ?? ""],
    queryFn: () => window.zyvro.git.status(),
    enabled: enabled && Boolean(project),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    // Keeping the previous answer while the next one is in flight is what stops
    // the list blinking empty every three seconds.
    placeholderData: (previous) => previous,
  })
}

export function useGitAction<TArgs>(run: (args: TArgs) => Promise<unknown>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: run,
    // Everything git does can change what is on disk, so the file tree and any
    // open file are re-read too, not just the status.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: gitKey })
      void client.invalidateQueries({ queryKey: ["files"] })
    },
  })
}

export const gitActions = {
  init: () => window.zyvro.git.init(),
  stage: (paths: string[]) => window.zyvro.git.stage(paths),
  unstage: (paths: string[]) => window.zyvro.git.unstage(paths),
  discard: (paths: string[]) => window.zyvro.git.discard(paths),
  commit: ({ message, options }: { message: string; options?: CommitOptions }) =>
    window.zyvro.git.commit(message, options ?? {}),
  checkout: (branch: string) => window.zyvro.git.checkout(branch),
  createBranch: (name: string) => window.zyvro.git.createBranch(name),
  fetch: () => window.zyvro.git.fetch(),
  pull: () => window.zyvro.git.pull(),
  push: () => window.zyvro.git.push(),
}
