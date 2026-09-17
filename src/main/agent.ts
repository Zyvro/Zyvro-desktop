import { type ChildProcess } from "node:child_process"
import { installed as cliInstalled, launchPiped } from "./cli"
import { describeTool, outputIn, planIn } from "./tooltalk"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { WebContents } from "electron"
import { SHOTS_SERVER, shotsEndpoint } from "./shots"

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
export function claudeMcpConfig(ctx: AgentContext): { path: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "zyvro-mcp-"))
  const file = path.join(dir, "mcp.json")
  // Deux serveurs : les workflows viennent du moteur, la capture d'écran vient
  // d'ici. Le moteur est un autre processus et ne peut pas photographier une
  // fenêtre Electron ; la fenêtre, elle, ne sait rien des workflows. Chacun
  // sert ce qu'il possède.
  const shots = shotsEndpoint()
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER]: {
          type: "http",
          url: mcpUrl(ctx),
          headers: { Authorization: `Bearer ${ctx.daemonToken}` },
        },
        ...(shots
          ? {
              [SHOTS_SERVER]: {
                type: "http",
                url: shots.origin,
                headers: { Authorization: `Bearer ${shots.token}` },
              },
            }
          : {}),
      },
    }),
    { mode: 0o600 }
  )
  return { path: file, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

// argsFor builds the command line for one turn.
//
// Pulled out and exported so it can be pinned by a check, because this is the
// part that breaks silently. The two CLIs disagree about how a session is
// resumed, and neither complains when you get it wrong:
//
//   claude   --resume <id> is a flag, anywhere on the line
//   codex    resume is a SUBCOMMAND, before its options, with the id positional
//
// Put codex's id in the wrong place and it is read as the prompt: the process
// starts, the model answers a question made of a UUID, and nothing anywhere
// says the session was not resumed. That is the failure worth a test.
//
// Both shapes were checked against the installed binaries rather than recalled
// — `codex exec resume --help` prints `[OPTIONS] [SESSION_ID] [PROMPT]`.
export function argsFor(
  kind: AgentKind,
  ctx: AgentContext,
  resume: string | null,
  model: string | null = null,
  images: string[] = []
): string[] {
  // An empty model is not a model. Passing `--model ""` is not the same as
  // passing nothing: the CLI takes it as a value and refuses it, and the user
  // sees a failure for a box they simply left alone.
  const pinned = model?.trim() ? model.trim() : null

  if (kind === "claude") {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      preamble(ctx),
      ...(pinned ? ["--model", pinned] : []),
      ...(resume ? ["--resume", resume] : []),
      // claude has no image flag: it reads an image by path with its Read tool,
      // so the paths go in the prompt — see promptWith. But its tools are
      // confined to the working directory, and the attachments live beside the
      // conversation, outside the project. Without this the agent answers "la
      // permission a été refusée" for a file it was just handed, which is
      // exactly what it did the first time this was run.
      //
      // Only the directories the images are actually in, and only when there
      // are images: widening tool access for a turn that does not need it
      // would be paying for a feature nobody used.
      ...(images.length > 0 ? ["--add-dir", ...directoriesOf(images)] : []),
    ]
  }
  return [
    "exec",
    ...(resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(pinned ? ["--model", pinned] : []),
    // -i takes one path per occurrence. Several paths after a single -i would
    // be swallowed as one argument by some shells and as the prompt by codex.
    ...images.flatMap((file) => ["-i", file]),
    ...(resume ? [resume] : []),
  ]
}

// directoriesOf is the set of folders a batch of images sits in, without
// repeats — one --add-dir per folder rather than per file.
function directoriesOf(files: string[]): string[] {
  return [...new Set(files.map((file) => path.dirname(file)))]
}

// promptWith is how images reach claude, which has no flag for them.
//
// It reads an image by path with its Read tool — verified against the binary:
// asked to read a logo from a path, it used Read and described the picture. So
// the paths are named in the message, with an instruction plain enough that it
// reads them before answering rather than talking about the filenames.
//
// codex gets nothing added here: it takes the same images as `-i` arguments,
// and repeating them in the text would make it describe a list of paths.
export function promptWith(kind: AgentKind, prompt: string, images: string[]): string {
  if (kind !== "claude" || images.length === 0) return prompt
  const listed = images.map((file) => `- ${file}`).join("\n")
  return `${prompt}\n\nThe user attached ${images.length === 1 ? "this image" : "these images"}. Read ${images.length === 1 ? "it" : "them"} with the Read tool before answering:\n${listed}`
}

// modelIn reads which model actually ran, out of the CLI's own init event.
//
// Shown rather than assumed, because the default is the CLI's to choose and it
// changes without asking us: a picker that printed a name of our own would be
// telling the person something we do not know. Claude puts it on the `system`
// init event; the `result` event keys its usage by the same name.
export function modelIn(event: Record<string, unknown>): string | null {
  const value = event.model
  if (typeof value === "string" && value.trim()) return value.trim()
  const usage = event.modelUsage
  if (usage && typeof usage === "object") {
    const [first] = Object.keys(usage as Record<string, unknown>)
    if (first) return first
  }
  return null
}

// aliasesFrom pulls the model aliases out of a CLI's own --help text.
//
// There is no machine-readable list to ask for — neither CLI has one — so the
// choice was between writing the names down here and reading them where the
// tool states them. Written down, they would be a second list: a new alias
// would appear in the CLI and never in this menu, and one that went away would
// stay in it and fail.
//
// The parse is deliberately narrow, and a parse that finds nothing is not a
// failure: the picker then offers the default and a box to type a name in,
// which is what it offers anyway for a full model name.
export function aliasesFrom(help: string): string[] {
  const sentence = /alias[^.]*?\(e\.g\.([^)]*)\)/is.exec(help)
  if (!sentence) return []
  return [...sentence[1].matchAll(/'([a-z0-9][a-z0-9.-]*)'/gi)].map((m) => m[1])
}

// sessionIn reads the CLI's own id for the conversation out of one event.
//
// The two call it different things — claude `session_id`, codex `thread_id` —
// and that was read out of their real output, not assumed. Guessing it wrong
// costs nothing visible: resume simply never happens, and the agent is
// amnesiac again with no error to explain it.
export function sessionIn(event: Record<string, unknown>): string | null {
  const value = event.session_id ?? event.thread_id
  return typeof value === "string" && value ? value : null
}

type Turn = {
  id: string
  conversationId: string
  child: ChildProcess
  // Whether any assistant text has gone out for this turn yet. The CLI emits
  // one assistant message per stretch of thinking, and between two of them
  // there is usually a tool call. Concatenating them verbatim runs the last
  // sentence of one into the first word of the next.
  sentText: boolean
}

export class AgentRunner {
  private turns = new Map<string, Turn>()

  // The CLI's own id for each conversation, learned from its output stream.
  //
  // This is what makes the agent remember. Without it every message opened a
  // fresh process that knew nothing of the one before: the panel showed a
  // conversation, and the CLI was answering a series of unrelated questions.
  // "Add a function" then "now the tests" got a puzzled answer about tests in
  // general, and nothing in the window explained why.
  //
  // Held here and handed back to the caller, which is what writes it down: this
  // class knows how to talk to a CLI and should not also own a file.
  private sessions = new Map<string, string>()

  // sessionFor is what the panel's persistence reads after a turn.
  sessionFor(conversationId: string): string | null {
    return this.sessions.get(conversationId) ?? null
  }

  // resumeAt seeds a session learned in a previous run of the app, so a
  // conversation reopened tomorrow carries on rather than starting over.
  resumeAt(conversationId: string, sessionId: string | null): void {
    if (sessionId) this.sessions.set(conversationId, sessionId)
    else this.sessions.delete(conversationId)
  }

  available(kind: AgentKind): string {
    return kind === "codex" ? "codex" : "claude"
  }

  // installed is what the panel asks before offering the agent at all, and it
  // asks cli.ts rather than the PATH directly: on Windows the thing called
  // `claude` is `claude.cmd`, and a check that only looked for `claude` would
  // report it missing on a machine where it works.
  installed(kind: AgentKind): boolean {
    return cliInstalled(this.available(kind))
  }

  // send starts one turn and streams it back.
  //
  // Each turn is still a fresh process — `claude -p` and `codex exec` are
  // one-shot by design — but it is no longer a fresh conversation: both CLIs
  // can pick up a previous session by id, and that id is what turns a row of
  // separate questions into a thread.
  send(
    target: WebContents,
    kind: AgentKind,
    prompt: string,
    ctx: AgentContext,
    conversationId: string,
    model: string | null = null,
    images: string[] = []
  ): string {
    const id = randomUUID()
    const resume = this.sessions.get(conversationId)
    const bin = this.available(kind)
    const env: NodeJS.ProcessEnv = { ...process.env }
    let disposeConfig: (() => void) | null = null

    const args: string[] = argsFor(kind, ctx, resume ?? null, model, images)

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
          // La capture est pré-accordée comme le reste : elle ne peut voir que
          // la fenêtre de l'application, et un tour en mode impression ne peut
          // demander la permission à personne.
          [`mcp__${MCP_SERVER}`, shotsEndpoint() ? `mcp__${SHOTS_SERVER}` : ""].filter(Boolean).join(",")
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
        const shots = shotsEndpoint()
        if (shots) {
          env.ZYVRO_SHOTS_TOKEN = shots.token
          args.push(
            "-c",
            `mcp_servers.${SHOTS_SERVER}.url="${shots.origin}"`,
            "-c",
            `mcp_servers.${SHOTS_SERVER}.bearer_token_env_var="ZYVRO_SHOTS_TOKEN"`
          )
        }
      }
    }

    if (kind === "codex") args.push("-")

    const withImages = promptWith(kind, prompt, images)
    const text = kind === "codex" ? `${preamble(ctx)}\n\n---\n\n${withImages}` : withImages

    // launch rather than spawn: it resolves the real file, which on Windows
    // carries an extension and may be a .cmd that Node refuses to start
    // without a shell.
    const child = launchPiped(bin, args, { cwd: ctx.projectDir, env })
    this.turns.set(id, { id, conversationId, child, sentText: false })

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

    // The session id, wherever it appears. Claude calls it session_id and puts
    // it on every event; codex calls it thread_id — a difference worth reading
    // out of the real output rather than assuming, because guessing it wrong
    // means resume silently never happens and the agent is amnesiac again.
    // Which model actually ran, reported once so the picker can show the CLI's
    // own default instead of a name we made up.
    const ranWith = modelIn(parsed)
    if (turn && ranWith) target.send("agent:model", { id, conversationId: turn.conversationId, model: ranWith })

    const learned = sessionIn(parsed)
    if (turn && learned) {
      if (this.sessions.get(turn.conversationId) !== learned) {
        this.sessions.set(turn.conversationId, learned)
        target.send("agent:session", { id, conversationId: turn.conversationId, sessionId: learned })
      }
    }
    const send = (text: string) => {
      if (!text) return
      // A new block starts a new paragraph, which is also what makes the
      // Markdown renderer treat it as one.
      const separator = turn?.sentText ? "\n\n" : ""
      if (turn) turn.sentText = true
      target.send("agent:text", { id, text: separator + text })
    }
    // A tool call and its result are two events, and the result can arrive out
    // of order: two Bash calls running at once come back in whichever finishes
    // first. So they are paired by the call's own id and never by arrival.
    const started = (callId: string, name: string, input: unknown) => {
      const talk = describeTool(name, input)
      target.send("agent:tool", {
        id,
        callId,
        name,
        running: talk.running,
        done: talk.done,
        shape: talk.shape,
        detail: talk.detail,
        plan: talk.shape === "plan" ? planIn(input) : [],
      })
    }
    const finished = (callId: string, content: unknown, isError: boolean) =>
      target.send("agent:tool-result", { id, callId, output: outputIn(content), isError })

    if (kind === "claude") {
      const type = parsed.type
      if (type === "assistant") {
        const message = parsed.message as { content?: unknown[] } | undefined
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown }
          if (b.type === "text" && b.text) send(b.text)
          if (b.type === "tool_use" && b.name) started(b.id ?? b.name, b.name, b.input)
        }
        return
      }

      // The results come back as a `user` message, which reads oddly until you
      // remember whose turn it is from the model's point of view: the tool
      // answered, and the answer is the user's half of the exchange.
      if (type === "user") {
        const message = parsed.message as { content?: unknown[] } | undefined
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
          if (b.type === "tool_result" && b.tool_use_id) {
            finished(b.tool_use_id, b.content, Boolean(b.is_error))
          }
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
    //
    // Its stream names things differently and is younger; what is handled here
    // is what it was seen to emit. Anything unrecognised still reaches the
    // panel as text rather than being dropped, which is the rule this whole
    // function follows.
    const codexItem = parsed.item as
      | { type?: string; text?: string; id?: string; name?: string; arguments?: unknown; output?: unknown; command?: string }
      | undefined
    if (parsed.type === "item.started" && codexItem?.type === "command_execution") {
      started(codexItem.id ?? "codex", "Bash", { command: codexItem.command })
      return
    }
    if (parsed.type === "item.completed" && codexItem?.type === "command_execution") {
      finished(codexItem.id ?? "codex", codexItem.output, false)
      return
    }

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
