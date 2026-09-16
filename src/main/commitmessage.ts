import { spawn } from "node:child_process"
import * as git from "./git"

// "Generate commit message", with the agent that is already on this machine.
//
// The same claude or codex the person uses in their terminal, in one-shot
// print mode. Nothing is sent to a server of ours, and there is no key to add:
// if they have a CLI they have this, and if they do not, the button says so
// instead of appearing and failing.
//
// The model is given the staged diff and nothing else — not the file names on
// their own, which produce "update index.js", and not the whole working tree,
// which describes work the commit will not contain. A commit message is a
// claim about a specific set of hunks, so those hunks are what it reads.

const MAX_DIFF_BYTES = 60_000

export type Agent = "claude" | "codex"

// which answers with the first CLI that actually runs. Asked by running it
// rather than by looking at PATH: a shell alias, a version manager shim or a
// binary without the execute bit all pass a PATH check and then fail.
export async function availableAgent(): Promise<Agent | null> {
  for (const agent of ["claude", "codex"] as Agent[]) {
    if (await runs(agent)) return agent
  }
  return null
}

function runs(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}

const INSTRUCTIONS = `You write one git commit message and nothing else.

Rules:
- One subject line, at most 72 characters, in the imperative mood.
- Use a Conventional Commits prefix when one clearly fits (feat, fix, docs, refactor, test, chore, perf, build, ci).
- Say what the change does and, when the diff makes it plain, why. Never restate the file names.
- No quotes around it, no backticks, no code fences, no preamble, no trailing full stop.
- If the diff is too small to justify a body, write only the subject line.
- You may add a blank line and a short body only when the change needs a reason that is not obvious.

Output the message. Nothing before it, nothing after it.`

// suggest reads what is staged, or the whole working tree when nothing is,
// which is the same rule the Commit button follows: what would be committed if
// you pressed it now is what the message should describe.
export async function suggest(root: string): Promise<string> {
  const agent = await availableAgent()
  if (!agent) {
    throw new Error(
      "No agent CLI was found on this machine. Install claude or codex and it will appear here."
    )
  }

  const state = await git.status(root)
  if (!state.repository) throw new Error("This folder is not a Git repository.")
  const staged = state.staged.length > 0
  const paths = (staged ? state.staged : state.unstaged).map((c) => c.path)
  if (paths.length === 0) throw new Error("There is nothing to describe: no file has changed.")

  let diff = ""
  for (const relative of paths) {
    if (diff.length >= MAX_DIFF_BYTES) break
    try {
      diff += await git.diff(root, relative, staged)
    } catch {
      // A binary file, or one that vanished between the status and here. The
      // rest of the diff is still worth describing.
    }
  }
  if (diff.length > MAX_DIFF_BYTES) {
    // Cut at a line boundary: half a hunk header reads as corruption and the
    // model will remark on it instead of writing the message.
    diff = diff.slice(0, MAX_DIFF_BYTES)
    diff = diff.slice(0, diff.lastIndexOf("\n")) + "\n\n[diff truncated]\n"
  }
  if (!diff.trim()) {
    // Nothing textual to read — a new binary file, or a pure rename. The names
    // are all there is, and saying so is better than sending an empty diff and
    // letting the model invent.
    diff = `No textual diff. The change is these files:\n${paths.map((p) => `- ${p}`).join("\n")}\n`
  }

  const answer = await ask(agent, `${INSTRUCTIONS}\n\n---\n\nHere is the diff:\n\n${diff}`, root)
  return clean(answer)
}

function ask(agent: Agent, prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Print mode, no tools, no MCP: this reads a diff and writes a sentence.
    // Handing it the project's tools would let a commit message cost a minute
    // and touch files, which is not what pressing a small button should do.
    const args = agent === "claude" ? ["-p"] : ["exec", "--skip-git-repo-check", "-"]
    const child = spawn(agent, args, { cwd, stdio: ["pipe", "pipe", "pipe"] })

    let out = ""
    let err = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", (error) => reject(new Error(`Could not run ${agent}: ${(error as Error).message}`)))
    child.on("close", (code) => {
      if (code === 0 && out.trim()) return resolve(out)
      reject(new Error(err.trim().split("\n")[0] || `${agent} wrote nothing back.`))
    })

    // A prompt this size does not belong in the process table, and a diff can
    // contain anything at all, so it goes over stdin.
    child.stdin.end(prompt)
  })
}

// clean strips what a CLI adds around an answer. Codex in particular prefixes
// its own log lines, and both will sometimes wrap a message in a code fence
// however plainly you ask them not to.
export function clean(raw: string): string {
  let text = raw.trim()

  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence) text = fence[1].trim()

  const lines = text.split("\n")
  // Codex's exec output starts with timestamped bookkeeping before the answer.
  while (lines.length > 0 && /^\[\d{4}-\d{2}-\d{2}T|^(thinking|codex|tokens used|User instructions|--------)\b/i.test(lines[0].trim())) {
    lines.shift()
  }
  while (lines.length > 0 && lines[0].trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()

  text = lines.join("\n").trim()
  // A model that was told not to quote sometimes quotes anyway.
  const quoted = /^"([\s\S]+)"$/.exec(text)
  if (quoted) text = quoted[1].trim()
  return text
}
