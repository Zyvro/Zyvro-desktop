import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveInside } from "./files"

// Git, the way VS Code does it: by talking to the git binary.
//
// Not through a JavaScript reimplementation. A library has to reimplement
// index format, ignore rules, renames, submodules, hooks, credential helpers
// and config precedence, and every one of those is a place it can disagree with
// the git the person runs in the terminal beside this window. Disagreeing about
// what is staged is worse than not showing it at all. The binary is already on
// the machine, it is the definition of the answer, and it is what the git
// extension shells out to for exactly this reason.
//
// Two rules hold everywhere in this file.
//
// Arguments are an array, never a string. Nothing here ever reaches a shell, so
// a branch called `; rm -rf ~` is a branch name and not a command. Paths that
// came from the renderer are checked against the project root first, the same
// gate files.ts uses, and passed after `--` so a file named `-f` is a file.
//
// Machine output, never human output. `--porcelain` with `-z` is the only
// format git promises not to change and the only one that survives a filename
// with a space, a newline or a quote in it. Parsing `git status` as a person
// reads it is how a panel ends up lying about a file whose name has a quote.

export class GitError extends Error {
  readonly code: number
  readonly stderr: string
  constructor(message: string, code: number, stderr: string) {
    super(message)
    this.code = code
    this.stderr = stderr
  }
}

// NotARepository is its own type because it is not a failure: it is the state
// every folder is in before anybody runs `git init`, and the panel answers it
// with an offer rather than an error.
export class NotARepository extends Error {
  constructor() {
    super("This folder is not a Git repository.")
  }
}

type RunOptions = {
  // stdin is how a commit message reaches git without ever being a shell
  // argument or a temporary file. A message with quotes, newlines and a
  // trailing backslash goes through unchanged.
  stdin?: string
  // Commands that answer with a non-zero code in an ordinary situation say so
  // here, so "nothing to do" does not raise.
  allow?: number[]
}

// Show Git Output, which VS Code has and which is the only honest answer to
// "pourquoi ça n'a pas marché". A panel that turns every failure into its own
// sentence eventually meets one it has no sentence for; the command and what
// git said about it always explain more than we can.
//
// A ring buffer, in memory, per process: this is a log to read now, not a
// record to keep, and writing the person's branch names to disk for no reason
// would be a small betrayal.
export type GitCommandLog = {
  at: string
  args: string[]
  code: number
  stderr: string
  ms: number
}

const LOG_LIMIT = 200
const commandLog: GitCommandLog[] = []

export function output(): GitCommandLog[] {
  return [...commandLog]
}

function record(entry: GitCommandLog): void {
  commandLog.push(entry)
  if (commandLog.length > LOG_LIMIT) commandLog.splice(0, commandLog.length - LOG_LIMIT)
}

function run(root: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      env: {
        ...process.env,
        // Git must never stop to ask this window for anything: there is no
        // terminal attached, so a prompt would hang the call forever instead of
        // failing. A push that needs a credential fails and says so.
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        // Output has to be the machine's, not the reader's: a French locale
        // would translate the messages this file matches on.
        LC_ALL: "C",
        LANG: "C",
      },
    })

    const started = Date.now()
    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", (error) => {
      reject(
        new GitError(
          `Could not run git: ${(error as Error).message}. Install Git, or make sure it is on the PATH this app was started with.`,
          -1,
          ""
        )
      )
    })
    child.on("close", (code) => {
      const status = code ?? -1
      record({ at: new Date().toISOString(), args, code: status, stderr: err.trim(), ms: Date.now() - started })
      if (status === 0 || options.allow?.includes(status)) return resolve(out)
      reject(new GitError(firstLine(err) || `git ${args[0]} failed (${status})`, status, err))
    })

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
}

// ---------- what a change is ----------

// Status letters are git's own, kept rather than translated into words of our
// own: they are what the person already reads in `git status --short`, what
// every tutorial shows, and what the column in the panel shows. Inventing a
// second vocabulary would mean teaching it.
export type ChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "type-changed"

export type Change = {
  // Relative to the repository root, POSIX separators — the form git speaks and
  // the form the renderer needs to ask for a diff.
  path: string
  // Where it came from, for a rename. The panel shows the arrow; the diff needs
  // both ends.
  from?: string
  status: ChangeStatus
  // The letter git prints in the short format, which is what the panel's right
  // column shows.
  letter: string
  staged: boolean
}

export type GitStatus = {
  repository: true
  root: string
  // The branch, or null on a detached HEAD, where there is no branch to name.
  branch: string | null
  // The commit, short, which is the only name a detached HEAD has.
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  // An unborn branch is a repository with no commit yet: everything is "added"
  // and there is nothing to diff against, which changes what the panel offers.
  unborn: boolean
  staged: Change[]
  unstaged: Change[]
  // Conflicts are their own group in VS Code and for good reason: they are the
  // only ones you cannot fix by clicking a plus, and mixing them into Changes
  // hides the one thing that needs doing first.
  conflicts: Change[]
  remotes: string[]
}

export type NoRepository = { repository: false; root: string }

// letterOf maps one side of git's two-letter code to the status the panel
// shows. X is the index, Y is the working tree; a letter belongs to whichever
// side is being read.
function fromCode(code: string): { status: ChangeStatus; letter: string } | null {
  switch (code) {
    case "M":
      return { status: "modified", letter: "M" }
    case "A":
      return { status: "added", letter: "A" }
    case "D":
      return { status: "deleted", letter: "D" }
    case "R":
      return { status: "renamed", letter: "R" }
    case "C":
      return { status: "copied", letter: "C" }
    case "T":
      return { status: "type-changed", letter: "T" }
    case "?":
      return { status: "untracked", letter: "U" }
    case "!":
      return { status: "ignored", letter: "I" }
    default:
      return null
  }
}

// CONFLICTED are the code pairs git uses for an unmerged path. They are listed
// rather than detected by "contains U", because `DD` and `AA` are conflicts
// too and contain no U at all.
const CONFLICTED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])

// parseStatus reads `git status --porcelain=v1 -z`.
//
// -z is not an optimisation. Without it git quotes and escapes any path that
// is not plain ASCII, so a file named `réglages.txt` or one with a space comes
// back wrapped in quotes with octal escapes inside, and a panel that forgot to
// unquote it asks git to stage a file that does not exist. With -z the records
// are separated by NUL and the paths are raw bytes.
//
// The awkward part, and the reason this is a hand-written loop rather than a
// split: a rename record spends *two* NUL-separated fields — the new path in
// the record itself and the old path in the field straight after it. So the
// reader has to consume a second field conditionally, which a map over split
// results cannot do.
export function parseStatus(output: string): { staged: Change[]; unstaged: Change[]; conflicts: Change[] } {
  const staged: Change[] = []
  const unstaged: Change[] = []
  const conflicts: Change[] = []

  const fields = output.split("\0")
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]
    if (record.length < 4) continue // "XY " plus at least one character of path

    const x = record[0]
    const y = record[1]
    const filePath = record.slice(3)
    const code = `${x}${y}`

    if (CONFLICTED.has(code)) {
      conflicts.push({ path: filePath, status: "conflicted", letter: code, staged: false })
      continue
    }

    if (x === "?" && y === "?") {
      unstaged.push({ path: filePath, status: "untracked", letter: "U", staged: false })
      continue
    }
    if (x === "!" && y === "!") {
      continue // ignored; asked for only when the panel wants it
    }

    // A rename or copy in the index carries its source in the next field.
    let from: string | undefined
    if (x === "R" || x === "C") {
      from = fields[++i]
    }

    const indexSide = fromCode(x)
    if (indexSide) {
      staged.push({ path: filePath, from, status: indexSide.status, letter: indexSide.letter, staged: true })
    }
    const treeSide = fromCode(y)
    if (treeSide) {
      // The working-tree side of a renamed entry is a change to the new path;
      // the rename itself is already recorded on the index side.
      unstaged.push({ path: filePath, status: treeSide.status, letter: treeSide.letter, staged: false })
    }
  }

  return { staged, unstaged, conflicts }
}

// parseBranchHeader reads the `## ` line `--branch` adds to the porcelain
// output. Its shapes: `## main...origin/main [ahead 2, behind 1]`,
// `## main` with no upstream, `## HEAD (no branch)` when detached, and
// `## No commits yet on main` for a repository nobody has committed to.
export function parseBranchHeader(line: string): Pick<GitStatus, "branch" | "upstream" | "ahead" | "behind" | "unborn"> {
  const empty = { branch: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, unborn: false }
  if (!line.startsWith("## ")) return empty
  let rest = line.slice(3)

  const unborn = /^No commits yet on /.test(rest)
  if (unborn) rest = rest.replace(/^No commits yet on /, "")
  if (rest.startsWith("HEAD (no branch)")) return { ...empty, unborn }

  const counts = /\[(.+)\]$/.exec(rest)
  let ahead = 0
  let behind = 0
  if (counts) {
    ahead = Number(/ahead (\d+)/.exec(counts[1])?.[1] ?? 0)
    behind = Number(/behind (\d+)/.exec(counts[1])?.[1] ?? 0)
    rest = rest.slice(0, counts.index).trim()
  }

  const [branch, upstream] = rest.split("...")
  return { branch: branch || null, upstream: upstream || null, ahead, behind, unborn }
}

// ---------- reading ----------

export async function isRepository(root: string): Promise<boolean> {
  try {
    // --show-toplevel rather than a .git check: a project opened inside a
    // repository is in a repository, and a .git file (a worktree or a
    // submodule) is not a directory.
    const top = (await run(root, ["rev-parse", "--show-toplevel"])).trim()
    return top.length > 0
  } catch {
    return false
  }
}

export async function status(root: string): Promise<GitStatus | NoRepository> {
  let top: string
  try {
    top = (await run(root, ["rev-parse", "--show-toplevel"])).trim()
  } catch {
    return { repository: false, root }
  }

  // --untracked-files=all rather than the default `normal`: normal collapses an
  // untracked directory into one entry, and "src/ is untracked" is not
  // something you can stage a file out of.
  const output = await run(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--branch",
  ])

  // The branch header is the first NUL-separated field, and it is the only one
  // that is newline-terminated rather than NUL-terminated.
  const cut = output.indexOf("\0")
  const header = (cut === -1 ? output : output.slice(0, cut)).split("\n")[0]
  const rest = cut === -1 ? "" : output.slice(cut + 1)

  const branchInfo = parseBranchHeader(header)
  const groups = parseStatus(rest)

  const head = branchInfo.unborn
    ? null
    : (await run(root, ["rev-parse", "--short", "HEAD"], { allow: [128] })).trim() || null

  const remotes = (await run(root, ["remote"])).split("\n").map((r) => r.trim()).filter(Boolean)

  return { repository: true, root: top, head, ...branchInfo, ...groups, remotes }
}

// diff answers with a unified diff for one path, so the renderer can show the
// two sides. `--no-color` and a fixed context keep the output stable.
export async function diff(root: string, relative: string, staged: boolean): Promise<string> {
  await resolveInside(root, relative)
  const args = ["diff", "--no-color", "--no-ext-diff"]
  if (staged) args.push("--staged")
  args.push("--", relative)
  return run(root, args)
}

// fileAt reads a path as of a revision, which is what a side-by-side diff needs
// for its left-hand pane. An untracked file has no such side, and asking for
// one answers empty rather than raising: "nothing there before" is the truth.
export async function fileAt(root: string, relative: string, revision: string): Promise<string> {
  await resolveInside(root, relative)
  try {
    return await run(root, ["show", `${revision}:${relative}`])
  } catch {
    return ""
  }
}

export type LogEntry = {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

// log reads history for the branch view. The separator is a NUL rather than a
// character somebody might put in a commit subject.
export async function log(root: string, limit = 50): Promise<LogEntry[]> {
  const out = await run(
    root,
    ["log", `--max-count=${Math.max(1, Math.min(500, limit))}`, "--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%x00"],
    { allow: [128] }
  )
  return out
    .split("\0\0")
    .map((row) => row.replace(/^\n/, ""))
    .filter((row) => row.trim().length > 0)
    .map((row) => {
      const [hash, short, author, date, subject] = row.split("\0")
      return { hash, short, author, date, subject: subject ?? "" }
    })
    .filter((entry) => Boolean(entry.hash))
}

export type Remote = { name: string; url: string }

// remoteList answers with the fetch URL of each remote, because "origin" alone
// is not enough to decide whether you are about to push to the right place.
export async function remoteList(root: string): Promise<Remote[]> {
  const out = await run(root, ["remote", "-v"], { allow: [128] })
  const seen = new Map<string, string>()
  for (const line of out.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (match) seen.set(match[1], match[2])
  }
  return [...seen].map(([name, url]) => ({ name, url }))
}

export async function addRemote(root: string, name: string, url: string): Promise<void> {
  await run(root, ["remote", "add", name, url])
}

export async function removeRemote(root: string, name: string): Promise<void> {
  await run(root, ["remote", "remove", name])
}

export type Stash = { index: number; label: string }

// Stashes are addressed by index, and the index shifts every time one is
// dropped or popped. So the label is carried with it and the caller is expected
// to re-read the list after any change rather than hold on to a number.
export async function stashList(root: string): Promise<Stash[]> {
  const out = await run(root, ["stash", "list", "--format=%gd%x00%s%x00%x00"], { allow: [128] })
  return out
    .split("\0\0")
    .map((row) => row.replace(/^\n/, ""))
    .filter((row) => row.trim())
    .map((row, index) => {
      const [, subject] = row.split("\0")
      return { index, label: subject ?? "" }
    })
}

export async function stash(root: string, message: string, includeUntracked: boolean): Promise<void> {
  const args = ["stash", "push"]
  // Untracked files are not stashed by default, which surprises everybody the
  // first time: you stash, the tree still has your new file in it, and you
  // conclude the stash did nothing.
  if (includeUntracked) args.push("--include-untracked")
  if (message.trim()) args.push("--message", message.trim())
  await run(root, args)
}

export async function stashPop(root: string, index: number): Promise<void> {
  await run(root, ["stash", "pop", `stash@{${Math.max(0, Math.trunc(index))}}`])
}

export async function stashApply(root: string, index: number): Promise<void> {
  await run(root, ["stash", "apply", `stash@{${Math.max(0, Math.trunc(index))}}`])
}

export async function stashDrop(root: string, index: number): Promise<void> {
  await run(root, ["stash", "drop", `stash@{${Math.max(0, Math.trunc(index))}}`])
}

export async function tags(root: string): Promise<string[]> {
  const out = await run(root, ["tag", "--sort=-creatordate"], { allow: [128] })
  return out.split("\n").map((t) => t.trim()).filter(Boolean)
}

export async function createTag(root: string, name: string, message: string): Promise<void> {
  // An annotated tag when there is something to say, a lightweight one
  // otherwise — which is the distinction git makes and the one people mean.
  if (message.trim()) await run(root, ["tag", "--annotate", name, "--message", message.trim()])
  else await run(root, ["tag", name])
}

export async function deleteTag(root: string, name: string): Promise<void> {
  await run(root, ["tag", "--delete", name])
}

export async function renameBranch(root: string, from: string, to: string): Promise<void> {
  await run(root, ["branch", "--move", from, to])
}

// deleteBranch refuses by default when the branch holds commits that are
// nowhere else, which is git's own guard and worth keeping: `--delete` says no,
// and only an explicit force says yes.
export async function deleteBranch(root: string, name: string, force: boolean): Promise<void> {
  await run(root, ["branch", force ? "-D" : "--delete", name])
}

export async function branches(root: string): Promise<string[]> {
  const out = await run(root, ["branch", "--format=%(refname:short)"], { allow: [128] })
  return out.split("\n").map((b) => b.trim()).filter(Boolean)
}

// ---------- writing ----------

export async function init(root: string): Promise<void> {
  await run(root, ["init"])
  // git decides the first branch name from init.defaultBranch, which is unset
  // on a fresh machine and makes git print a paragraph about it. Nothing is
  // forced here: the warning is git's to give, and picking a name behind the
  // person's back is how a tool ends up disagreeing with their own config.
}

// paths are checked one by one before any of them is sent. All or nothing: a
// staging call that did half its list and then refused would leave the index in
// a state the person did not ask for and cannot see.
async function checkedPaths(root: string, relatives: string[]): Promise<string[]> {
  if (relatives.length === 0) throw new Error("No file was named.")
  for (const relative of relatives) await resolveInside(root, relative)
  return relatives
}

export async function stage(root: string, relatives: string[]): Promise<void> {
  const paths = await checkedPaths(root, relatives)
  // --all so a deletion stages as a deletion. `git add <deleted file>` alone
  // does record it in modern git, but being explicit means this does not depend
  // on which git is installed.
  await run(root, ["add", "--all", "--", ...paths])
}

export async function unstage(root: string, relatives: string[]): Promise<void> {
  const paths = await checkedPaths(root, relatives)

  // Before the first commit there is no HEAD, and "put it back the way HEAD has
  // it" is a question with no answer: `git restore --staged` fails outright with
  // "could not resolve HEAD". Unstaging there means taking the file out of the
  // index and leaving it on disk, which is what `rm --cached` does.
  //
  // Found by check-git.mjs on the second call it ever made. It is exactly the
  // state a person is in one minute after clicking Initialize Repository — they
  // stage everything, notice one file they did not mean to, and click the minus.
  if (await isUnborn(root)) {
    await run(root, ["rm", "--cached", "--", ...paths])
    return
  }
  // `restore --staged` rather than `reset`, because it says what it does.
  await run(root, ["restore", "--staged", "--", ...paths])
}

// isUnborn is "this repository has no commit yet". Asked of git rather than
// inferred from a status we already read, because unstaging can be called on
// its own and a stale answer here deletes from the index instead of restoring.
async function isUnborn(root: string): Promise<boolean> {
  try {
    await run(root, ["rev-parse", "--verify", "HEAD"])
    return false
  } catch {
    return true
  }
}

// discard throws away work, which is the one thing here that cannot be undone
// by another git command. The renderer asks before calling it; this function
// does not ask, because a confirmation buried in the main process is a
// confirmation nobody can style or translate.
export async function discard(root: string, relatives: string[]): Promise<void> {
  const paths = await checkedPaths(root, relatives)
  // Two different operations behind one word. A tracked file goes back to what
  // the index holds; an untracked file has no such state to go back to and is
  // deleted. Sorting them here rather than asking the renderer to means the
  // panel cannot get the distinction wrong.
  const tracked: string[] = []
  const untracked: string[] = []
  for (const relative of paths) {
    const known = await run(root, ["ls-files", "--error-unmatch", "--", relative], { allow: [1, 128] })
    if (known.trim()) tracked.push(relative)
    else untracked.push(relative)
  }
  if (tracked.length > 0) await run(root, ["checkout", "--", ...tracked])
  for (const relative of untracked) {
    const absolute = await resolveInside(root, relative)
    await fs.rm(absolute, { recursive: true, force: true })
  }
}

export type CommitOptions = { amend?: boolean; stageAll?: boolean }

export async function commit(root: string, message: string, options: CommitOptions = {}): Promise<void> {
  const text = message.trim()
  if (!text && !options.amend) throw new Error("A commit needs a message.")
  if (options.stageAll) await run(root, ["add", "--all"])

  const args = ["commit", "--file=-"]
  if (options.amend) args.push("--amend")
  // --cleanup=strip is git's own default for a message it reads from a file,
  // spelled out so a change to the person's commit.cleanup config cannot make
  // the message they typed come out different from what they saw.
  args.push("--cleanup=strip")
  await run(root, args, { stdin: text })
}

export async function checkout(root: string, branch: string): Promise<void> {
  await run(root, ["checkout", branch])
}

export async function createBranch(root: string, name: string): Promise<void> {
  await run(root, ["checkout", "-b", name])
}

export async function fetch(root: string): Promise<void> {
  await run(root, ["fetch", "--prune"])
}

export async function pull(root: string): Promise<void> {
  // --ff-only rather than a merge or a rebase. Both of the others can stop
  // half-way and leave a repository in a state this panel does not yet know how
  // to get out of, and doing that to somebody who pressed a button labelled
  // "pull" is worse than telling them to finish it in the terminal.
  await run(root, ["pull", "--ff-only"])
}

// pushTo is Push to… : the branch goes where the person says, and the choice
// is remembered as the upstream so the plain Push afterwards needs no question.
export async function pushTo(root: string, remote: string, setUpstream: boolean): Promise<void> {
  const state = await status(root)
  if (!state.repository) throw new NotARepository()
  if (!state.branch) throw new Error("A detached HEAD has no branch to push.")
  const args = ["push"]
  if (setUpstream) args.push("--set-upstream")
  args.push(remote, state.branch)
  await run(root, args)
}

export async function pushTags(root: string): Promise<void> {
  await run(root, ["push", "--tags"])
}

export async function push(root: string): Promise<void> {
  const state = await status(root)
  if (!state.repository) throw new NotARepository()
  if (!state.branch) throw new Error("A detached HEAD has no branch to push.")
  if (state.remotes.length === 0) {
    throw new Error("This repository has no remote yet, so there is nowhere to push.")
  }
  if (state.upstream) {
    await run(root, ["push"])
    return
  }
  // First push of a branch: name where it goes, and remember it, so the next
  // one is just `push`.
  await run(root, ["push", "--set-upstream", state.remotes[0], state.branch])
}

// clone is the one command here that does not run inside an open project: it
// makes the folder the project will be. The parent is chosen by the person
// through a real directory dialog, so nothing in the renderer decides where on
// the disk this lands.
//
// The destination is derived from the URL rather than asked for, the way git
// itself does it, and then checked: a URL is remote input, and a repository
// name of `../..` would otherwise decide where the clone goes.
export async function clone(parent: string, url: string): Promise<string> {
  const name = cloneFolderName(url)
  const target = path.join(parent, name)
  if (path.dirname(target) !== path.resolve(parent)) {
    throw new Error(`That URL would clone outside the folder you chose.`)
  }
  await run(parent, ["clone", "--", url, name])
  return target
}

export function cloneFolderName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  const last = trimmed.split(/[/:]/).pop() ?? ""
  const name = last.replace(/\.git$/, "")
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`Could not work out a folder name from "${url}".`)
  }
  return name
}
