// Le bouton bug : ce qui part quand quelqu'un dit « ça a planté ».
//
// Un tour bloqué sur « Writing… » que Stop n'arrête pas ne laisse aucune trace
// qu'on puisse lire après coup : le transcript n'est écrit qu'à la fin d'un
// tour, et celui-là ne finit jamais. Ce qui permet de comprendre, c'est l'état
// à ce moment-là — ce que l'écran croit en cours, ce que le processus principal
// tient vraiment, les dernières lignes que la CLI a imprimées, les erreurs vues
// en chemin. Ce module garde les erreurs au fil de l'eau et assemble le reste
// au moment de l'envoi.
//
// Rien ne part sans le bouton : le journal reste sur la machine tant que
// personne n'envoie de rapport.

import os from "node:os"
import { app, type WebContents } from "electron"

export type Incident = { at: number; source: string; message: string }

const MAX_INCIDENTS = 200
const MAX_INCIDENT_CHARS = 4000
const incidents: Incident[] = []
let unreported = 0
const listeners = new Set<(count: number) => void>()

/**
 * Une erreur vue en chemin : un processus de rendu tombé, une exception non
 * rattrapée, un tour d'agent en échec, un Stop qui a dû forcer. Gardée dans une
 * file bornée — la plus ancienne part quand la file est pleine.
 */
export function recordIncident(source: string, message: string): void {
  incidents.push({ at: Date.now(), source, message: String(message).slice(0, MAX_INCIDENT_CHARS) })
  if (incidents.length > MAX_INCIDENTS) incidents.splice(0, incidents.length - MAX_INCIDENTS)
  unreported++
  for (const listener of listeners) listener(unreported)
}

export function incidentLog(): Incident[] {
  return incidents.slice()
}

/** Combien d'erreurs depuis le dernier rapport : le bouton rougit au-delà de zéro. */
export function unreportedIncidents(): number {
  return unreported
}

export function onIncident(listener: (count: number) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function markReported(): void {
  unreported = 0
  for (const listener of listeners) listener(0)
}

// ---- masquer ce qui ressemble à un secret ------------------------------------
//
// L'état contient des conversations, et une conversation peut contenir une clé
// collée par erreur, un jeton dans une sortie d'outil. On masque les formes
// connues avant l'envoi. Ce n'est pas une garantie — un mot de passe n'a pas de
// forme — et la fenêtre le dit à la personne avant qu'elle envoie.
const SECRET_PATTERNS: RegExp[] = [
  // Clés de fournisseurs : Anthropic, OpenAI, et les nôtres.
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bzk_[A-Za-z0-9_-]{16,}/g,
  // GitHub, Google, Slack, AWS.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Un jeton porteur dans un en-tête recopié.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // Les jetons de nos propres serveurs locaux : 48 caractères hexadécimaux.
  /\b[0-9a-f]{48}\b/g,
  // Une clé privée collée en entier.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const scheme = /^(Bearer|Basic)\s/i.exec(match)
      return scheme ? `${scheme[1]} [redacted]` : "[redacted]"
    })
  }
  return out
}

// ---- assembler -----------------------------------------------------------------

/** Ce que le processus principal sait de la machine et de lui-même. */
export function appState(): Record<string, unknown> {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1e6),
    locale: app.getLocale(),
  }
}

// Le serveur refuse au-delà de 5 Mo d'état. On réduit ce qui pèse le plus et
// dit le moins avant de renoncer : d'abord les vieux messages des conversations
// qu'on ne regardait pas, puis les lignes brutes des tours, puis tout sauf la
// conversation active.
const MAX_STATE_CHARS = 4_500_000

type RendererState = { chat?: { threads?: { id: string; messages?: unknown[] }[]; activeId?: string } } & Record<string, unknown>

export function fitState(state: { renderer?: RendererState; main?: { turns?: { lines?: string[] }[] } } & Record<string, unknown>): string {
  let text = redact(JSON.stringify(state))
  if (text.length <= MAX_STATE_CHARS) return text

  const chat = state.renderer?.chat
  const steps: (() => void)[] = [
    () => chat?.threads?.forEach((t) => t.id !== chat.activeId && t.messages && (t.messages = t.messages.slice(-10))),
    () => state.main?.turns?.forEach((t) => t.lines && (t.lines = t.lines.slice(-10))),
    () => chat?.threads?.forEach((t) => t.messages && (t.messages = t.messages.slice(-20))),
    () => chat && (chat.threads = chat.threads?.filter((t) => t.id === chat.activeId)),
  ]
  for (const step of steps) {
    step()
    state.trimmed = true
    text = redact(JSON.stringify(state))
    if (text.length <= MAX_STATE_CHARS) return text
  }
  return text
}

export type BugReportInput = { kind: "manual" | "crash"; description: string; renderer: unknown }

/**
 * Assemble et envoie. `post` est l'appel au serveur (main/account.ts), passé
 * en paramètre pour que ce module ne connaisse ni la clé ni l'adresse.
 */
export async function sendBugReport(
  input: BugReportInput,
  mainSnapshot: unknown,
  post: (body: string) => Promise<unknown>
): Promise<string> {
  const state = fitState({
    app: appState(),
    main: mainSnapshot as { turns?: { lines?: string[] }[] },
    renderer: input.renderer as RendererState,
    incidents: incidentLog(),
  })
  const answer = (await post(
    JSON.stringify({
      kind: input.kind,
      description: redact(input.description.slice(0, 20_000)),
      app_version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      state: JSON.parse(state),
    })
  )) as { id?: unknown }
  const id = typeof answer?.id === "string" ? answer.id : ""
  if (!id) throw new Error("the server accepted the report but returned no id")
  markReported()
  return id
}

/** Écoute les plantages d'une fenêtre : ils entrent au journal. */
export function watchContents(contents: WebContents, label: string): void {
  contents.on("render-process-gone", (_event, details) => recordIncident(`${label}:gone`, `${details.reason} (exit code ${details.exitCode})`))
  contents.on("unresponsive", () => recordIncident(`${label}:unresponsive`, "the window stopped responding"))
  contents.on("preload-error", (_event, preloadPath, error) => recordIncident(`${label}:preload`, `${preloadPath}: ${error.message}`))
}
