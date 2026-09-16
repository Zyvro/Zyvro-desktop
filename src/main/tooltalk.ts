// Saying what the agent just did, in a sentence a person reads without
// stopping.
//
// The stream carries everything: every `tool_use` with its input, every
// `tool_result` with its output. The panel used to keep the tool's name and
// throw the rest away, so somebody watching it write code read "ran Edit".
//
// The shape is the one VS Code and Cursor both settled on, read out of their
// shipped code rather than recalled:
//
//   - two tenses, `invocationMessage` while it runs and `pastTenseMessage`
//     after: "Editing file" then "Edited math.ts"
//   - the phrase names its subject, never the tool alone
//   - a detail per kind of tool, not one blob of JSON: a command for a
//     terminal, a pattern for a search, a checklist for a plan
//
// Which is why this is a table of tools rather than a pretty-printer. A
// pretty-printer would show `{"file_path":"/long/…/math.js"}` for every one of
// them, which is the same as showing nothing.

export type ToolShape = "read" | "edit" | "terminal" | "search" | "web" | "plan" | "agent" | "zyvro" | "other"

export type ToolTalk = {
  /** While it runs. */
  running: string
  /** Once it has. */
  done: string
  /** Which specialised body to draw, if any. */
  shape: ToolShape
  /** The one line worth showing without expanding: a command, a pattern. */
  detail: string
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// The last segment of a path, which is what a person recognises. The full path
// is still there when the row is expanded.
function base(file: string): string {
  const parts = file.split(/[/\\]/)
  return parts[parts.length - 1] || file
}

// A command long enough to wrap is a command nobody reads on a summary line.
function short(text: string, limit = 64): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

export function describeTool(name: string, input: unknown): ToolTalk {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const file = str(args.file_path) || str(args.path) || str(args.notebook_path)
  const pattern = str(args.pattern) || str(args.query)

  switch (name) {
    case "Read":
      return { running: `Reading ${base(file)}`, done: `Read ${base(file)}`, shape: "read", detail: file }
    case "Write":
      return { running: `Writing ${base(file)}`, done: `Wrote ${base(file)}`, shape: "edit", detail: file }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { running: `Editing ${base(file)}`, done: `Edited ${base(file)}`, shape: "edit", detail: file }
    case "BashOutput":
      // Not a Bash call: it reads what a command started earlier has printed
      // so far. Folding it into Bash gave it an empty sentence — "Running "
      // with nothing after it — because it carries a shell id and no command.
      return {
        running: "Checking on a running command",
        done: "Checked on a running command",
        shape: "terminal",
        detail: str(args.bash_id) || str(args.shell_id),
      }
    case "Bash": {
      // The description is the model's own one-line summary of why it is
      // running this, and it reads better than the command. The command is the
      // detail, because that is the thing worth checking.
      const command = str(args.command)
      const why = short(str(args.description) || command, 48)
      return { running: `Running ${why}`, done: `Ran ${why}`, shape: "terminal", detail: command }
    }
    case "KillShell":
      return { running: "Stopping a command", done: "Stopped a command", shape: "terminal", detail: str(args.shell_id) }
    case "Glob":
    case "Grep": {
      const where = str(args.path)
      const target = short(pattern, 40)
      const suffix = where ? ` in ${base(where)}` : ""
      return {
        running: `Searching for ${target}${suffix}`,
        done: `Searched for ${target}${suffix}`,
        shape: "search",
        detail: pattern,
      }
    }
    case "WebSearch":
      return { running: `Searching the web for ${short(pattern, 40)}`, done: `Searched the web for ${short(pattern, 40)}`, shape: "web", detail: pattern }
    case "WebFetch": {
      const url = str(args.url)
      return { running: `Fetching ${short(url, 48)}`, done: `Fetched ${short(url, 48)}`, shape: "web", detail: url }
    }
    case "TodoWrite":
      return { running: "Updating the plan", done: "Updated the plan", shape: "plan", detail: "" }
    case "Task": {
      const what = short(str(args.description) || str(args.subagent_type), 44)
      return { running: `Delegating ${what}`, done: `Delegated ${what}`, shape: "agent", detail: str(args.prompt) }
    }
    default: {
      // Zyvro's own tools arrive over MCP, named mcp__zyvro__run_workflow and
      // so on. Showing that verbatim is showing the plumbing.
      const mcp = /^mcp__([^_]+)__(.+)$/.exec(name)
      if (mcp) {
        const readable = mcp[2].replace(/_/g, " ")
        return { running: `${readable} (${mcp[1]})`, done: `${readable} (${mcp[1]})`, shape: "zyvro", detail: "" }
      }
      return { running: `Running ${name}`, done: `Ran ${name}`, shape: "other", detail: "" }
    }
  }
}

// A plan is the one input worth reading as itself: TodoWrite carries the
// agent's own checklist, and VS Code gives it a `todoList` body for exactly
// that reason.
export type PlanItem = { title: string; status: string }

export function planIn(input: unknown): PlanItem[] {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const todos = args.todos
  if (!Array.isArray(todos)) return []
  return todos
    .map((todo) => {
      const item = (todo && typeof todo === "object" ? todo : {}) as Record<string, unknown>
      return { title: str(item.content) || str(item.title), status: str(item.status) || "pending" }
    })
    .filter((item) => item.title !== "")
}

// A tool result can be a string or a list of blocks, and a Read of a large file
// is a great deal of text. Flattened and capped here rather than in the
// renderer, so a megabyte never crosses IPC to be thrown away on the other
// side.
const MAX_OUTPUT = 4000

export function outputIn(content: unknown): string {
  let text: string
  if (typeof content === "string") text = content
  else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const b = (block && typeof block === "object" ? block : {}) as Record<string, unknown>
        return str(b.text)
      })
      .filter(Boolean)
      .join("\n")
  } else text = ""

  const trimmed = text.trimEnd()
  if (trimmed.length <= MAX_OUTPUT) return trimmed
  return `${trimmed.slice(0, MAX_OUTPUT)}\n…(${trimmed.length - MAX_OUTPUT} more characters)`
}
