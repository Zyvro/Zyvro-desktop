// Ce qu'un agent demande à la personne en plein tour, et la réponse.
//
// Deux chemins y mènent : l'outil de permission du serveur MCP de
// l'application (Claude, qui ne sait pas dans quelle fenêtre il tourne) et le
// serveur d'application de Codex (qui le sait). Les deux attendent ici, dans
// une seule file, et le panneau répond par un seul canal.
//
// Elle attend, longtemps : quelqu'un doit avoir le temps de lire. Mais pas
// indéfiniment — un tour laissé en plan tiendrait un processus CLI ouvert, et
// la personne n'aurait plus rien à cliquer.

import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import type { AgentQuestion } from "../shared/questions"
import type { AskAnswer } from "./shots"

const ASK_PATIENCE_MS = 10 * 60 * 1000

type Pending = { settle: (answer: AskAnswer) => void }
const pending = new Map<string, Pending>()

export type AskRequest = { tool: string; input: Record<string, unknown>; questions?: AgentQuestion[] }

/**
 * Pose la demande dans cette fenêtre et attend la réponse.
 *
 * `signal` : la demande devient sans objet — le tour a été interrompu, le
 * serveur l'a résolue lui-même. Elle quitte alors l'écran, et la promesse rend
 * un refus que personne ne lira.
 */
export function askIn(contents: WebContents, request: AskRequest, signal?: AbortSignal): Promise<AskAnswer> {
  const id = randomUUID()
  contents.send("agent:permission", { id, ...request })

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (answer: AskAnswer) => {
      if (!pending.has(id)) return
      if (timer) clearTimeout(timer)
      pending.delete(id)
      signal?.removeEventListener("abort", onAbort)
      resolve(answer)
    }
    // Réglée ailleurs qu'au panneau : la carte doit partir aussi, sinon on
    // répond à une demande qui n'attend plus personne.
    const withdraw = (message: string) => {
      settle({ allow: false, message })
      if (!contents.isDestroyed()) contents.send("agent:permission-gone", { id })
    }
    const onAbort = () => withdraw("the request was withdrawn")
    pending.set(id, { settle })
    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => withdraw("nobody answered — ask again, or change what the agent may do"), ASK_PATIENCE_MS)
  })
}

/** La réponse du panneau. Faux si la demande n'attendait plus. */
export function answerAsk(id: string, answer: AskAnswer): boolean {
  const waiting = pending.get(id)
  if (!waiting) return false
  waiting.settle(answer)
  return true
}
