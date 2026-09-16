// Git, exercised against a real repository rather than a described one.
//
// Everything in src/main/git.ts is a reader of somebody else's output format,
// which is the shape of bug this project keeps meeting: the code describes what
// git prints, the description is subtly wrong, and nothing fails — the panel
// just shows the wrong thing, or stages a file the person did not name.
//
// So this makes a repository in a temporary folder and drives the real binary.
// The awkward cases are the point: a filename with a space, one with an accent,
// one with a quote in it. Without `-z`, git quotes and octal-escapes all three,
// and a reader that forgot to unquote asks git to stage a file that does not
// exist — silently, because `git add` on a missing path is an error nobody
// surfaces.
//
//     node scripts/check-git.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-git-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "harness.ts"), `export * from "${path.join(ROOT, "src/main/git").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "harness.ts")],
  outfile: path.join(dir, "harness.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const git = createRequire(import.meta.url)(path.join(dir, "harness.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const repo = mkdtempSync(path.join(os.tmpdir(), "zyvro-git-"))
const sh = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
const write = (name, text) => writeFileSync(path.join(repo, name), text, "utf8")
const pathsOf = (list) => list.map((c) => c.path).sort()

try {
  // ---- a folder that is not a repository -------------------------------
  const before = await git.status(repo)
  check("a plain folder answers that it is not a repository", before.repository === false)

  await git.init(repo)
  sh("config", "user.email", "check@zyvro.invalid")
  sh("config", "user.name", "Zyvro Check")
  sh("config", "commit.gpgsign", "false")
  check("after init it is one", await git.isRepository(repo))

  // ---- a repository with no commit yet ----------------------------------
  write("readme.md", "# hello\n")
  const unborn = await git.status(repo)
  check("an unborn branch is reported as unborn", unborn.repository && unborn.unborn === true, JSON.stringify(unborn).slice(0, 200))
  check("it has no HEAD to name", unborn.head === null)
  check("the new file shows as untracked", pathsOf(unborn.unstaged).includes("readme.md"))
  check("untracked files carry the letter U", unborn.unstaged.find((c) => c.path === "readme.md")?.letter === "U")

  // ---- names that break a reader who skipped -z -------------------------
  //
  // The quote is the sharpest case and the one Windows cannot have: NTFS
  // refuses `"` in a filename outright, so including it unconditionally made
  // this check fail on the Windows release runner with ENOENT — a check about
  // reading someone else's rules, failing because it assumed someone else's
  // rules. The accented names carry the same point everywhere: without `-z`,
  // git escapes them in octal and a reader that forgot to unescape asks for a
  // file that does not exist.
  const windows = process.platform === "win32"
  const awkward = [
    "a file with spaces.txt",
    "réglages.txt",
    "accentué é.md",
    ...(windows ? [] : [`quote"inside.txt`]),
  ]
  for (const name of awkward) write(name, "x\n")
  const messy = await git.status(repo)
  for (const name of awkward) {
    check(`\`${name}\` comes back unescaped`, pathsOf(messy.unstaged).includes(name), `got: ${pathsOf(messy.unstaged).join(" | ")}`)
  }

  // ---- staging ----------------------------------------------------------
  await git.stage(repo, awkward)
  const staged = await git.status(repo)
  for (const name of awkward) {
    check(`\`${name}\` stages by the name it was given`, pathsOf(staged.staged).includes(name))
  }
  check("the staged ones left the unstaged group", !pathsOf(staged.unstaged).some((p) => awkward.includes(p)))
  check("a staged new file carries A", staged.staged.find((c) => c.path === awkward[0])?.letter === "A")

  await git.unstage(repo, [awkward[0]])
  const unstaged = await git.status(repo)
  check("unstaging puts it back", pathsOf(unstaged.unstaged).includes(awkward[0]) && !pathsOf(unstaged.staged).includes(awkward[0]))

  // ---- committing -------------------------------------------------------
  await git.stage(repo, ["readme.md"])
  // A message with the things that break an argument or a shell: quotes,
  // newlines, a trailing backslash, a dollar sign.
  const message = `feat: prouver que "ça" passe\n\nUne ligne avec $HOME et un \\ à la fin \\`
  await git.commit(repo, message)
  const committed = await git.status(repo)
  check("committing leaves an unborn branch behind", committed.unborn === false)
  check("there is a HEAD now", typeof committed.head === "string" && committed.head.length > 0)
  const entries = await git.log(repo, 10)
  check("the log has the commit", entries.length === 1, JSON.stringify(entries).slice(0, 160))
  check(
    "the subject survived quotes and a dollar sign",
    entries[0]?.subject === 'feat: prouver que "ça" passe',
    `got ${entries[0]?.subject}`
  )
  check("the body did not become a second commit", entries.length === 1)

  // ---- modifying, renaming, deleting ------------------------------------
  write("readme.md", "# hello\n\nmore\n")
  const modified = await git.status(repo)
  check("a modified tracked file carries M", modified.unstaged.find((c) => c.path === "readme.md")?.letter === "M")

  await git.stage(repo, ["readme.md"])
  await git.commit(repo, "docs: more")
  sh("mv", "readme.md", "readme-renamed.md")
  const renamed = await git.status(repo)
  const rename = renamed.staged.find((c) => c.status === "renamed")
  check("a staged rename is seen as a rename", Boolean(rename), JSON.stringify(renamed.staged).slice(0, 200))
  check("and it remembers where it came from", rename?.from === "readme.md", `from=${rename?.from}`)
  check("the rename's two paths did not eat the next record", renamed.staged.length === 1 || renamed.staged.every((c) => c.path.length > 0))

  await git.commit(repo, "docs: rename")
  // Deleted from disk, not with `git rm`: `git rm` stages the deletion as it
  // goes, and what the panel has to cope with is a file the person removed in
  // the Finder or with an editor, which is an *unstaged* deletion.
  rmSync(path.join(repo, "readme-renamed.md"))
  const deleted = await git.status(repo)
  check("a deletion carries D", deleted.unstaged.find((c) => c.path === "readme-renamed.md")?.letter === "D")
  await git.stage(repo, ["readme-renamed.md"])
  check("a deletion can be staged", (await git.status(repo)).staged.some((c) => c.letter === "D"))
  await git.unstage(repo, ["readme-renamed.md"])

  // ---- discard, the one that cannot be undone ---------------------------
  await git.discard(repo, ["readme-renamed.md"])
  const restored = await git.status(repo)
  check("discarding a deletion brings the file back", !pathsOf(restored.unstaged).includes("readme-renamed.md"))
  await git.discard(repo, [awkward[0]])
  check("discarding an untracked file removes it", !pathsOf((await git.status(repo)).unstaged).includes(awkward[0]))

  // ---- branches and a detached HEAD -------------------------------------
  await git.createBranch(repo, "feature/with-slash")
  const onBranch = await git.status(repo)
  check("the branch name is read back whole", onBranch.branch === "feature/with-slash", `got ${onBranch.branch}`)
  check("it is listed", (await git.branches(repo)).includes("feature/with-slash"))
  check("no upstream yet", onBranch.upstream === null && onBranch.ahead === 0 && onBranch.behind === 0)

  sh("checkout", "--detach")
  const detached = await git.status(repo)
  check("a detached HEAD has no branch", detached.branch === null)
  check("but it still has a commit", typeof detached.head === "string" && detached.head.length > 0)
  sh("checkout", "feature/with-slash")

  // ---- ahead and behind, against a real remote --------------------------
  const remote = mkdtempSync(path.join(os.tmpdir(), "zyvro-git-remote-"))
  execFileSync("git", ["init", "--bare"], { cwd: remote })
  sh("remote", "add", "origin", remote)
  sh("push", "--set-upstream", "origin", "feature/with-slash")
  const synced = await git.status(repo)
  check("the upstream is read", synced.upstream === "origin/feature/with-slash", `got ${synced.upstream}`)
  check("and the remote is listed", synced.remotes.includes("origin"))

  write("ahead.txt", "1\n")
  await git.stage(repo, ["ahead.txt"])
  await git.commit(repo, "feat: ahead by one")
  const ahead = await git.status(repo)
  check("one commit ahead reads as 1", ahead.ahead === 1 && ahead.behind === 0, `ahead=${ahead.ahead} behind=${ahead.behind}`)
  await git.push(repo)
  check("pushing clears it", (await git.status(repo)).ahead === 0)

  // ---- a conflict, which is its own group -------------------------------
  sh("checkout", "-b", "other")
  write("clash.txt", "theirs\n")
  await git.stage(repo, ["clash.txt"])
  await git.commit(repo, "feat: theirs")
  sh("checkout", "feature/with-slash")
  write("clash.txt", "ours\n")
  await git.stage(repo, ["clash.txt"])
  await git.commit(repo, "feat: ours")
  try {
    sh("merge", "other")
  } catch {
    /* the conflict is the point */
  }
  const conflicted = await git.status(repo)
  check("a conflict lands in its own group", conflicted.conflicts.some((c) => c.path === "clash.txt"), JSON.stringify(conflicted.conflicts))
  check("and not in Changes", !pathsOf(conflicted.unstaged).includes("clash.txt"))
  check("and not in Staged Changes", !pathsOf(conflicted.staged).includes("clash.txt"))
  sh("merge", "--abort")

  // ---- diff -------------------------------------------------------------
  write("ahead.txt", "1\n2\n")
  const patch = await git.diff(repo, "ahead.txt", false)
  check("an unstaged diff mentions the file", patch.includes("ahead.txt") && patch.includes("+2"))
  await git.stage(repo, ["ahead.txt"])
  const stagedPatch = await git.diff(repo, "ahead.txt", true)
  check("a staged diff is read from the index", stagedPatch.includes("+2"))
  check("the previous contents are readable", (await git.fileAt(repo, "ahead.txt", "HEAD")) === "1\n")
  check("a file with no previous side answers empty", (await git.fileAt(repo, "nope.txt", "HEAD")) === "")

  // ---- the path gate ----------------------------------------------------
  let refused = false
  try {
    await git.stage(repo, ["../escape.txt"])
  } catch (err) {
    refused = /outside the open project/.test(err.message)
  }
  check("a path outside the project is refused", refused)

  refused = false
  try {
    await git.diff(repo, "/etc/passwd", false)
  } catch (err) {
    refused = /outside the open project/.test(err.message)
  }
  check("and so is an absolute one", refused)

  // ---- a list the panel read a moment too early -------------------------
  // The panel shows what status said; by the time somebody clicks the plus the
  // file may be gone. It has to fail with something a person can read, not with
  // a stack trace.
  let stale = ""
  try {
    await git.stage(repo, ["vanished.txt"])
  } catch (err) {
    stale = err.message
  }
  check("staging a file that is no longer there says so", /did not match any files/.test(stale), `got ${stale}`)

  // ---- a commit with no message -----------------------------------------
  refused = false
  try {
    await git.commit(repo, "   ")
  } catch (err) {
    refused = /needs a message/.test(err.message)
  }
  check("an empty commit message is refused here, not by git", refused)

  // ---- remises, etiquettes, remotes, branches ---------------------------
  const remotes = await git.remoteList(repo)
  check("the remote is listed with its URL", remotes.some((r) => r.name === "origin" && r.url === remote), JSON.stringify(remotes))

  await git.addRemote(repo, "mirror", remote)
  check("a remote can be added", (await git.remoteList(repo)).some((r) => r.name === "mirror"))
  await git.removeRemote(repo, "mirror")
  check("and removed", !(await git.remoteList(repo)).some((r) => r.name === "mirror"))

  // A stash has to take untracked files with it, which is not git's default and
  // is the thing everyone is caught by once.
  write("stashed.txt", "keep me\n")
  write("ahead.txt", "1\n2\n3\n")
  await git.stash(repo, "work in progress", true)
  const afterStash = await git.status(repo)
  check("stashing clears the working tree", afterStash.staged.length + afterStash.unstaged.length === 0, JSON.stringify(afterStash.unstaged))
  const stashes = await git.stashList(repo)
  check("the stash is listed", stashes.length === 1, JSON.stringify(stashes))
  check("with its message", stashes[0]?.label.includes("work in progress"), stashes[0]?.label)
  await git.stashPop(repo, 0)
  const afterPop = await git.status(repo)
  check("popping brings the tracked change back", afterPop.unstaged.concat(afterPop.staged).some((c) => c.path === "ahead.txt"))
  check("and the untracked file with it", afterPop.unstaged.concat(afterPop.staged).some((c) => c.path === "stashed.txt"))
  check("the stash list is empty again", (await git.stashList(repo)).length === 0)

  await git.stage(repo, ["ahead.txt", "stashed.txt"])
  await git.commit(repo, "chore: settle the tree")

  await git.createTag(repo, "v0.1.0", "first")
  check("an annotated tag is created", (await git.tags(repo)).includes("v0.1.0"))
  await git.createTag(repo, "v0.1.1", "")
  check("a lightweight one too", (await git.tags(repo)).includes("v0.1.1"))
  await git.deleteTag(repo, "v0.1.1")
  check("and deleted", !(await git.tags(repo)).includes("v0.1.1"))

  await git.createBranch(repo, "to-rename")
  await git.renameBranch(repo, "to-rename", "renamed")
  check("a branch can be renamed", (await git.branches(repo)).includes("renamed") && !(await git.branches(repo)).includes("to-rename"))
  sh("checkout", "feature/with-slash")
  await git.deleteBranch(repo, "renamed", true)
  check("and deleted", !(await git.branches(repo)).includes("renamed"))

  // Push to a named remote, which is what "Push to…" does.
  write("pushed.txt", "x\n")
  await git.stage(repo, ["pushed.txt"])
  await git.commit(repo, "feat: push to a named remote")
  await git.pushTo(repo, "origin", true)
  check("pushing to a named remote works", (await git.status(repo)).ahead === 0)
  await git.pushTags(repo)
  check("tags can be pushed", execFileSync("git", ["ls-remote", "--tags", remote], { encoding: "utf8" }).includes("v0.1.0"))

  // ---- le journal des commandes -----------------------------------------
  const journal = git.output()
  check("every command was recorded", journal.length > 20, `${journal.length} entries`)
  check("a recorded entry names its arguments", journal.some((e) => e.args[0] === "status"))
  check("and a failure kept git's own words", journal.some((e) => e.code !== 0 && e.stderr.length > 0))

  // ---- le nom de dossier deduit d'une URL de clone -----------------------
  check("an https URL gives its repository name", git.cloneFolderName("https://github.com/Zyvro/Zyvro-desktop.git") === "Zyvro-desktop")
  check("an ssh URL too", git.cloneFolderName("git@github.com:Zyvro/Zyvro-desktop.git") === "Zyvro-desktop")
  check("a trailing slash is not a folder called nothing", git.cloneFolderName("https://example.com/thing/") === "thing")
  let badUrl = false
  try {
    // The name comes from remote input, so a repository called `..` must not
    // decide where on the disk the clone lands.
    git.cloneFolderName("https://example.com/..")
  } catch {
    badUrl = true
  }
  check("a URL whose name is .. is refused", badUrl)

  rmSync(remote, { recursive: true, force: true })
} finally {
  rmSync(repo, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nGit does what the panel will show." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
