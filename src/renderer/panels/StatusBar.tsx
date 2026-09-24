import { useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, Check, CircleSlash, Cpu, GitBranch, Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { CompletionToggle } from "~/panels/CompletionToggle"
import { UsageToggle } from "~/panels/UsageToggle"
import { ShotButton } from "~/panels/ShotPicker"
import { useWorkspace } from "~/state/workspace"
import { UpdatePill } from "~/panels/UpdateDialog"
import { gitActions, useGitAction, useGitStatus } from "~/lib/git"
import { engineDown, subscribeEngine } from "~/state/engine"
import { gitRunning, subscribeGit, type GitRunning } from "~/state/git"
import * as Menu from "@radix-ui/react-dropdown-menu"
import {
  editorActionsOf,
  editorStatusOf,
  indentationText,
  positionText,
  subscribeEditorStatus,
} from "~/state/editorStatus"

const IDLE_GIT: GitRunning = { verb: "", done: false, failed: false }

// The one line that answers "can this project actually run anything right now".
// On a desktop app that question is mostly about which CLIs are installed, so
// that is what it leads with.

// Ce que VS Code affiche à droite de sa barre, pour l'éditeur actif : la
// position, l'indentation, les fins de ligne et la langue. Chaque morceau est
// aussi un bouton, comme là-bas : la position mène à « Go to Line », les fins
// de ligne basculent entre LF et CRLF, l'indentation se choisit.
const itemMenu =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-[12px] outline-none data-[highlighted]:bg-white/[0.09]"

function EditorPills() {
  const tabId = useWorkspace((s) => s.activeTabId)
  const status = useSyncExternalStore(
    subscribeEditorStatus,
    () => editorStatusOf(tabId),
    () => null
  )
  if (!status) return null
  const actions = editorActionsOf(tabId)
  const bouton = "rounded px-1 hover:bg-white/[0.08] hover:text-foreground"
  return (
    <>
      <button className={bouton} title="Go to Line" onClick={() => actions?.goToLine()}>
        {positionText(status)}
      </button>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button className={bouton} title="Select Indentation">
            {indentationText(status)}
          </button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content side="top" align="end" sideOffset={6} className="panel z-50 min-w-[180px] p-1">
            {[
              [true, 2],
              [true, 4],
              [false, 2],
              [false, 4],
            ].map(([spaces, size]) => (
              <Menu.Item
                key={`${spaces}-${size}`}
                className={itemMenu}
                onSelect={() => actions?.setIndentation(spaces as boolean, size as number)}
              >
                <Check
                  className={cn(
                    "h-3 w-3",
                    status.insertSpaces === spaces && status.tabSize === size ? "opacity-100" : "opacity-0"
                  )}
                />
                {spaces ? `Indent using spaces: ${size}` : `Indent using tabs: ${size}`}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <button
        className={bouton}
        title={status.eol === "LF" ? "Change end of line sequence to CRLF" : "Change end of line sequence to LF"}
        onClick={() => actions?.setEol(status.eol === "LF" ? "CRLF" : "LF")}
      >
        {status.eol}
      </button>
      <span>{status.language}</span>
    </>
  )
}

type LocalStatus = {
  project: string
  workflows: number
  cli: { claude: boolean; codex: boolean }
}

function CliPill({ name, ready }: { name: string; ready: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1",
        ready ? "text-emerald-300/90" : "text-muted-foreground/70"
      )}
      title={
        ready
          ? `${name} is installed; workflows can use your subscription through it.`
          : `${name} was not found on your PATH.`
      }
    >
      {ready ? <Check className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
      {name}
    </span>
  )
}

// The branch, where every editor puts it. It earns the corner because it
// answers a question people ask constantly and would otherwise open a panel
// for: which branch am I on, and am I out of step with the remote.
//
// Clicking it syncs, which is the pair of commands nobody wants to think about
// separately: bring down what is there, then send up what is not.
function GitPill() {
  const setPanel = useWorkspace((s) => s.setPanel)
  // Ce que git fait en ce moment, d'où que ça vienne : le bouton de commit, le
  // menu, ou cette pastille. C'est le seul endroit toujours à l'écran, donc
  // c'est celui qui doit le dire quoi qu'il arrive.
  const activite = useSyncExternalStore(subscribeGit, gitRunning, () => IDLE_GIT)
  const status = useGitStatus()
  const pull = useGitAction(gitActions.pull)
  const push = useGitAction(gitActions.push)
  const repo = status.data?.repository ? status.data : null
  // `occupe` : ça tourne. `travail` : ça tourne, ou ça vient de finir et on
  // l'annonce encore. Les deux, parce qu'un push qui dure trois secondes et
  // disparaît sans un mot laisse exactement le doute qu'on essaie d'enlever.
  const occupe = activite.verb !== "" && !activite.done
  const travail = activite.verb !== ""
  if (!repo) return null

  const sync = async () => {
    if (repo.behind > 0) await pull.mutateAsync(undefined)
    if (repo.ahead > 0) await push.mutateAsync(undefined)
  }
  const failure = (pull.error ?? push.error) as Error | null

  return (
    <span className="flex items-center gap-2">
      <button
        className="flex items-center gap-1 hover:text-foreground"
        title="Open source control"
        onClick={() => setPanel("git", true)}
      >
        <GitBranch className="h-3 w-3" />
        {repo.branch ?? `detached ${repo.head}`}
      </button>
      {repo.upstream && (
        <button
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-[1px] hover:text-foreground disabled:opacity-100",
            // Pendant l'opération, la pastille se teinte. Un tourniquet de
            // douze pixels dans un coin est exactement ce qu'on ne voit pas :
            // c'est la surface entière qui doit changer d'état, pas une icône.
            travail && !activite.failed && "bg-primary/15 text-primary",
            travail && activite.failed && "bg-destructive/15 text-destructive"
          )}
          disabled={occupe}
          title={
            failure
              ? failure.message
              : repo.behind || repo.ahead
                ? `${repo.behind} to pull, ${repo.ahead} to push`
                : "Up to date with " + repo.upstream
          }
          onClick={() => void sync()}
        >
          {travail ? (
            <>
              {occupe ? (
                <Loader2 className="h-3 w-3 shrink-0 zy-spin" />
              ) : activite.failed ? (
                <CircleSlash className="h-3 w-3 shrink-0" />
              ) : (
                <Check className="h-3 w-3 shrink-0" />
              )}
              {/* Le verbe, parce qu'un rond qui tourne dit « attends » là où
                  « Pushing… » dit ce qu'on attend. */}
              <span>{occupe ? `${activite.verb}…` : activite.verb}</span>
            </>
          ) : repo.behind === 0 && repo.ahead === 0 ? (
            <RefreshCw className="h-3 w-3" />
          ) : (
            <>
              {repo.behind > 0 && (
                <>
                  <ArrowDown className="h-3 w-3" />
                  {repo.behind}
                </>
              )}
              {repo.ahead > 0 && (
                <>
                  <ArrowUp className="h-3 w-3" />
                  {repo.ahead}
                </>
              )}
            </>
          )}
        </button>
      )}
      {/* Tronqué : un message de git fait parfois trois lignes, et la barre
          d'état n'a qu'une ligne. Le texte entier reste dans l'infobulle. */}
      {failure && (
        <span className="max-w-[28rem] truncate text-destructive" title={failure.message}>
          {failure.message}
        </span>
      )}
    </span>
  )
}

export function StatusBar() {
  const project = useWorkspace((s) => s.project)
  const stopped = useSyncExternalStore(subscribeEngine, engineDown, () => null)
  const dirtyCount = useWorkspace((s) => Object.keys(s.drafts).length)

  const status = useQuery({
    queryKey: ["local", "status"],
    queryFn: async (): Promise<LocalStatus> => {
      const res = await fetch("http://127.0.0.1:0/api/local/status")
      if (!res.ok) throw new Error(`status ${res.status}`)
      return res.json() as Promise<LocalStatus>
    },
    enabled: Boolean(project),
    refetchInterval: 15_000,
  })

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-white/[0.06] bg-background px-3 text-[11px] text-muted-foreground">
      {/* Le port du moteur, et le cas où il n'y en a plus.
          Un moteur peut mourir en cours de route — il est un processus enfant,
          il plante. Continuer d'afficher son port est pire que de ne rien
          afficher : on cherche la panne du côté de ce qui appelle, pendant que
          le chiffre est là, à l'écran, l'air vivant. */}
      <span className={cn("flex items-center gap-1", stopped && "text-amber-300")}>
        <Cpu className="h-3 w-3" />
        {stopped
          ? `Local engine stopped${stopped.code === null ? "" : ` (code ${stopped.code})`} — reopen the project to start it again`
          : project
            ? `Local engine on port ${project.daemon.port}`
            : "No project open"}
      </span>

      <CompletionToggle />
      <UsageToggle />
      <ShotButton />

      {status.data && (
        <>
          <CliPill name="claude" ready={status.data.cli.claude} />
          <CliPill name="codex" ready={status.data.cli.codex} />
          <span>
            {status.data.workflows} workflow{status.data.workflows === 1 ? "" : "s"}
          </span>
        </>
      )}

      <GitPill />

      <div className="flex-1" />

      {/* The update offer lives here and stays here until the user acts on it,
          so an engine they chose not to install is never lost, only quiet. */}

      {dirtyCount > 0 && (
        <span className="text-foreground/80">
          {dirtyCount} unsaved file{dirtyCount === 1 ? "" : "s"}
        </span>
      )}

      <EditorPills />
      <UpdatePill />
    </footer>
  )
}
