import type { AgentKind } from "./harness"

// These are local interactive commands, never model prompts. Use the CLI's
// own credential store so the next panel turn sees the same signed-in account.
export function isLoginCommand(text: string): boolean {
  return /^\/(login|auth)\s*$/i.test(text.trim())
}

export function loginArgs(kind: AgentKind): string[] {
  switch (kind) {
    case "claude": return ["auth", "login"]
    case "codex": return ["login"]
    case "mimo": return ["auth", "login"]
    case "qwen": return ["--prompt-interactive", "/auth"]
  }
}
