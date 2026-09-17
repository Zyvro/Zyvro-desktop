// Un serveur MCP qui photographie l'application.
//
// Pourquoi ici et pas dans le moteur : le moteur sert déjà des outils MCP —
// lister les workflows, en lancer un, lire un résultat — mais c'est un
// processus Go séparé, et il ne peut pas photographier une fenêtre Electron.
// Seul le processus principal peut le faire, donc l'outil vit là où vit la
// fenêtre.
//
// Pourquoi l'ajouter du tout : sans lui, capturer l'app demande de la relancer
// avec un port de débogage distant et de piloter le renderer par CDP. Ça marche
// et c'est une porte ouverte sur la machine pour prendre une image de sa propre
// fenêtre. Ceci demande au processus qui possède déjà la fenêtre.
//
// Ce qu'il ne fait pas : l'écran. `capturePage` ne rend que le contenu de la
// fenêtre de l'application — pas les autres fenêtres, pas le bureau, pas ce qui
// passe devant. C'est une limite du procédé et elle est voulue : un outil qui
// peut lire l'écran d'une machine est un outil dont il faut se méfier, et
// aucune capture de produit n'en a besoin.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BrowserWindow, Rectangle } from "electron"

export const SHOTS_SERVER = "zyvro-app"
export const TOOL_SCREENSHOT = "zyvro_screenshot"
export const TOOL_LIST_WINDOWS = "zyvro_list_windows"

export type ShotArgs = {
  /** Laquelle. Absente : celle qui a le focus, sinon la première ouverte. */
  window?: number
  /** Une région de la fenêtre, en pixels logiques. Absente : tout. */
  rect?: Rectangle
  /** Où écrire le fichier. Absent : l'image revient dans la réponse. */
  path?: string
  /** Réduction : 1 rend la taille d'origine, 0.5 la moitié. */
  scale?: number
}

// clampScale garde la réduction dans ce qui a un sens. Un facteur nul rendrait
// une image vide, un facteur énorme demanderait des gigaoctets à un processus
// qui doit aussi afficher l'interface.
export function clampScale(scale: unknown): number {
  const n = typeof scale === "number" && Number.isFinite(scale) ? scale : 1
  return Math.min(2, Math.max(0.1, n))
}

// cleanRect refuse une région qui n'en est pas une plutôt que de la corriger en
// silence : une hauteur négative rendrait une image vide, et personne ne
// saurait pourquoi.
export function cleanRect(raw: unknown): Rectangle | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN)
  const rect = { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) }
  if (Object.values(rect).some(Number.isNaN)) return undefined
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return rect as Rectangle
}

// pickWindow choisit la fenêtre à photographier.
//
// L'application peut en avoir plusieurs — un projet par fenêtre — donc en
// nommer une est le cas normal, pas l'exception. Sans indication, celle qui a
// le focus : c'est celle que la personne regarde en le demandant.
export function pickWindow(all: BrowserWindow[], id?: number): BrowserWindow | undefined {
  const open = all.filter((w) => !w.isDestroyed())
  if (typeof id === "number") return open.find((w) => w.id === id)
  return open.find((w) => w.isFocused()) ?? open[0]
}

export function describeWindows(all: BrowserWindow[]): Array<Record<string, unknown>> {
  return all
    .filter((w) => !w.isDestroyed())
    .map((w) => {
      const [width, height] = w.getSize()
      return { id: w.id, title: w.getTitle(), width, height, focused: w.isFocused(), visible: w.isVisible() }
    })
}

export const listWindowsTool = {
  name: TOOL_LIST_WINDOWS,
  description:
    "List the Zyvro Studio windows that are open, with their id and size. Pass an id to zyvro_screenshot to capture one of them.",
  inputSchema: { type: "object", properties: {} },
  annotations: { title: "List app windows", readOnlyHint: true, openWorldHint: false },
}

export const screenshotTool = {
  name: TOOL_SCREENSHOT,
  description:
    "Take a screenshot of a Zyvro Studio window. Returns the image, or writes it to a file when a path is given. " +
    "It captures the application window only — never the screen, another window, or anything in front of it.",
  inputSchema: {
    type: "object",
    properties: {
      window: {
        type: "number",
        description: "Which window, from zyvro_list_windows. Omit for the focused one.",
      },
      rect: {
        type: "object",
        description: "A region of the window, in logical pixels. Omit for the whole window.",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["x", "y", "width", "height"],
      },
      path: {
        type: "string",
        description: "Write the PNG here instead of returning it. An existing file is replaced.",
      },
      scale: { type: "number", description: "Scale the result, 0.1 to 2. Default 1." },
    },
  },
  annotations: {
    title: "Screenshot the app",
    // Elle ne change rien à l'état du produit — sauf quand on lui donne un
    // chemin, et c'est alors le seul effet qu'elle a.
    readOnlyHint: true,
    openWorldHint: false,
  },
}

export type ShotResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }

// takeShot capture et rend ce que le protocole attend.
export async function takeShot(all: BrowserWindow[], args: ShotArgs): Promise<ShotResult> {
  const win = pickWindow(all, args.window)
  if (!win) {
    const open = describeWindows(all)
    throw new Error(
      open.length === 0
        ? "no window to capture: Zyvro Studio is not open"
        : `no window with id ${args.window}. Open: ${open.map((w) => `${w.id} (${w.title})`).join(", ")}`
    )
  }
  const rect = cleanRect(args.rect)
  let image = await win.webContents.capturePage(rect)

  const scale = clampScale(args.scale)
  if (scale !== 1) {
    const size = image.getSize()
    image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
  }
  const png = image.toPNG()

  const target = typeof args.path === "string" ? args.path.trim() : ""
  if (target) {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, png)
    const { width, height } = image.getSize()
    return { content: [{ type: "text", text: `Wrote ${width}×${height} to ${target}` }] }
  }
  return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] }
}

// ---- le transport ------------------------------------------------------
//
// Le même que celui du moteur : JSON-RPC sur une requête HTTP, un jeton en
// en-tête. Il écoute sur la boucle locale et sur un port que le système
// choisit, donc rien de tout ceci n'est joignable depuis une autre machine.

type Handle = { origin: string; token: string; close: () => void }

let running: Handle | null = null

export function shotsEndpoint(): Handle | null {
  return running
}

export async function startShotsServer(windows: () => BrowserWindow[]): Promise<Handle> {
  if (running) return running
  const token = randomBytes(24).toString("hex")

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, token, windows)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  running = {
    origin: `http://127.0.0.1:${port}`,
    token,
    close: () => {
      server.close()
      running = null
    },
  }
  return running
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  windows: () => BrowserWindow[]
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }))
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: ShotArgs } }
  try {
    msg = JSON.parse(body || "{}")
  } catch {
    res.writeHead(400).end(JSON.stringify({ error: "bad json" }))
    return
  }

  const reply = (result: unknown) =>
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }))

  try {
    switch (msg.method) {
      case "initialize":
        reply({
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SHOTS_SERVER, version: "1" },
        })
        return
      case "notifications/initialized":
        res.writeHead(202).end()
        return
      case "tools/list":
        reply({ tools: [listWindowsTool, screenshotTool] })
        return
      case "tools/call": {
        switch (msg.params?.name) {
          case TOOL_LIST_WINDOWS:
            reply({ content: [{ type: "text", text: JSON.stringify(describeWindows(windows()), null, 1) }] })
            return
          case TOOL_SCREENSHOT:
            reply(await takeShot(windows(), msg.params?.arguments ?? {}))
            return
          default:
            throw new Error(`no such tool: ${msg.params?.name}`)
        }
      }
      default:
        res.writeHead(404).end(JSON.stringify({ error: `unknown method ${msg.method}` }))
    }
  } catch (err) {
    // Une erreur d'outil se rend dans le résultat, pas dans le code HTTP : le
    // client doit pouvoir la lire et la montrer au modèle.
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] },
      })
    )
  }
}
