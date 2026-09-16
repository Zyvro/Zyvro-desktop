import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { WebContents } from "electron"

// The chat panel runs the user's own agent CLI in the project directory. That
// is the whole reason this app exists: a ChatGPT or Claude subscription cannot
// be reached from a server, but the CLI on this machine is already signed in.
// Zyvro never sees a token; it sees stdout.

export type AgentKind = "claude" | "codex"

export type AgentContext = {
  projectDir: string
  workflows: { id: string; name: string; description?: string }[]
  // The local daemon's origin and token. With them the CLI gets the Zyvro MCP
  // tools and can actually run a workflow; without them it can only read the
  // JSON files, which is the difference between an assistant that acts and one
  // that describes.
  daemonOrigin?: string
  daemonToken?: string
}

// The MCP server is named "zyvro" here so the tools carry the same names the
// hosted product documents. An agent that has used Zyvro over MCP before finds
// exactly what it expects.
const MCP_SERVER = "zyvro"

// preamble tells the CLI what this project's workflows are. Without it the
// agent is a generic coding assistant that has never heard of Zyvro; with it,
// asking "run the product photo workflow" is a sentence it can act on.
function preamble(ctx: AgentContext): string {
  const lines = [
    `You are the Zyvro Studio assistant, working inside the project at ${ctx.projectDir}.`,
    "Zyvro workflows are visual AI graphs stored in .zyvro/workflows/ as JSON.",
  ]

  if (ctx.workflows.length === 0) {
    lines.push("This project has no workflows yet.")
  } else {
    lines.push(
      "This project defines these workflows:",
      ...ctx.workflows.map(
        (w) => `- ${w.name} (id ${w.id})${w.description ? `: ${w.description}` : ""}`
      )
    )
  }

  if (mcpAvailable(ctx)) {
    lines.push(
      "",
      "You have the Zyvro tools for this project. Use them rather than reading the",
      "JSON by hand: zyvro_list_workflows, zyvro_workflow_graph, zyvro_run_workflow,",
      "zyvro_execution_status, zyvro_get_output, zyvro_list_executions.",
      "Running a workflow spends the user's own model account, so run one when the",
      "user asks for it, not to satisfy your own curiosity about what it does."
    )
  }

  return lines.join("\n")
}

function mcpAvailable(ctx: AgentContext): boolean {
  return Boolean(ctx.daemonOrigin && ctx.daemonToken)
}

function mcpUrl(ctx: AgentContext): string {
  return `${ctx.daemonOrigin}/mcp`
}

// claudeMcpConfig writes the server definition to a file rather than passing it
// on the command line, because it carries the daemon token and argv is readable
// by every process on the machine. The file is created with owner-only
// permissions and deleted when the turn ends.
function claudeMcpConfig(ctx: AgentContext): { path: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "zyvro-mcp-"))
  const file = path.join(dir, "mcp.json")
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER]: {
          type: "http",
          url: mcpUrl(ctx),
          headers: { Authorization: `Bearer ${ctx.daemonToken}` },
        },
      },
    }),
    { mode: 0o600 }
  )
  return { path: file, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

type Turn = {
  id: string
  child: ChildProcess
  // Whether any assistant text has gone out for this turn yet. The CLI emits
  // one assistant message per stretch of thinking, and between two of them
  // there is usually a tool call. Concatenating them verbatim runs the last
  // sentence of one into the first word of the next.
  sentText: boolean
}

export class AgentRunner {
  private turns = new Map<string, Turn>()

  available(kind: AgentKind): string {
    return kind === "codex" ? "codex" : "claude"
  }

  // send starts one turn and streams it back. Each turn is a fresh process:
  // `claude -p` and `codex exec` are one-shot by design, and threading a
  // session id through them is a later refinement, not a prototype concern.
  send(target: WebContents, kind: AgentKind, prompt: string, ctx: AgentContext): string {
    const id = randomUUID()
    const bin = this.available(kind)
    const env: NodeJS.ProcessEnv = { ...process.env }
    let disposeConfig: (() => void) | null = null

    const args: string[] =
      kind === "claude"
        ? ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", preamble(ctx)]
        : ["exec", "--json", "--skip-git-repo-check"]

    if (mcpAvailable(ctx)) {
      if (kind === "claude") {
        const config = claudeMcpConfig(ctx)
        disposeConfig = config.dispose
        args.push(
          "--mcp-config",
          config.path,
          // Only this project's server. Without it the user's own MCP servers
          // would also load into the panel, which is a surprise nobody asked
          // for and a different set of tools on every machine.
          "--strict-mcp-config",
          // A print-mode run cannot prompt for permission, so the Zyvro tools
          // are pre-approved. Nothing else is: the CLI's own file and shell
          // tools keep whatever policy the user configured.
          "--allowedTools",
          `mcp__${MCP_SERVER}`
        )
      } else {
        // Codex reads the token from the environment rather than from a flag,
        // which keeps it out of the process table.
        env.ZYVRO_MCP_TOKEN = ctx.daemonToken
        args.push(
          "-c",
          `mcp_servers.${MCP_SERVER}.url="${mcpUrl(ctx)}"`,
          "-c",
          `mcp_servers.${MCP_SERVER}.bearer_token_env_var="ZYVRO_MCP_TOKEN"`
        )
      }
    }

    if (kind === "codex") args.push("-")

    const text = kind === "codex" ? `${preamble(ctx)}\n\n---\n\n${prompt}` : prompt

    const child = spawn(bin, args, {
      cwd: ctx.projectDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.turns.set(id, { id, child, sentText: false })

    child.stdin.write(text)
    child.stdin.end()

    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) this.emitEvent(target, id, kind, line)
        index = buffer.indexOf("\n")
      }
    })

    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    child.on("error", (err: NodeJS.ErrnoException) => {
      this.turns.delete(id)
      disposeConfig?.()
      disposeConfig = null
      const detail =
        err.code === "ENOENT"
          ? `"${bin}" is not on your PATH. Install it and sign in, then reopen this panel.`
          : err.message
      if (!target.isDestroyed()) target.send("agent:error", { id, message: detail })
    })

    child.on("exit", (code) => {
      this.turns.delete(id)
      disposeConfig?.()
      disposeConfig = null
      if (target.isDestroyed()) return
      if (buffer.trim()) this.emitEvent(target, id, kind, buffer.trim())
      if (code !== 0) {
        target.send("agent:error", { id, message: stderr.trim() || `${bin} exited with code ${code}` })
        return
      }
      target.send("agent:done", { id })
    })

    return id
  }

  // emitEvent normalizes the two CLIs' stream formats into one shape. Neither
  // format is contractual, so anything unrecognized is forwarded as raw text
  // rather than dropped: a silent panel is worse than an ugly one.
  private emitEvent(target: WebContents, id: string, kind: AgentKind, line: string): void {
    if (target.isDestroyed()) return
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      target.send("agent:text", { id, text: line })
      return
    }

    const turn = this.turns.get(id)
    const send = (text: string) => {
      if (!text) return
      // A new block starts a new paragraph, which is also what makes the
      // Markdown renderer treat it as one.
      const separator = turn?.sentText ? "\n\n" : ""
      if (turn) turn.sentText = true
      target.send("agent:text", { id, text: separator + text })
    }
    const note = (tool: string) => target.send("agent:tool", { id, tool })

    if (kind === "claude") {
      const type = parsed.type
      if (type === "assistant") {
        const message = parsed.message as { content?: unknown[] } | undefined
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; text?: string; name?: string }
          if (b.type === "text" && b.text) send(b.text)
          if (b.type === "tool_use" && b.name) note(b.name)
        }
        return
      }
      if (type === "result") {
        const result = parsed.result
        if (parsed.is_error && typeof result === "string") {
          target.send("agent:error", { id, message: result })
        }
        return
      }
      return
    }

    // Codex
    const item = parsed.item as { type?: string; text?: string } | undefined
    if (parsed.type === "item.completed" && item?.type === "agent_message" && item.text) {
      send(item.text)
      return
    }
    const msg = parsed.msg as { type?: string; message?: string } | undefined
    if (msg?.type === "agent_message" && msg.message) {
      send(msg.message)
      return
    }
    if (typeof parsed.last_agent_message === "string") send(parsed.last_agent_message)
  }

  cancel(id: string): void {
    const turn = this.turns.get(id)
    if (!turn) return
    this.turns.delete(id)
    turn.child.kill()
  }

  cancelAll(): void {
    for (const id of [...this.turns.keys()]) this.cancel(id)
  }
}
