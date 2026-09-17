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
import {
  TOOL_BROWSER_CLICK,
  TOOL_BROWSER_EVAL,
  TOOL_BROWSER_KEY,
  TOOL_BROWSER_LOGS,
  TOOL_BROWSER_OPEN,
  TOOL_BROWSER_READ,
  TOOL_BROWSER_SCROLL,
  TOOL_BROWSER_SET,
  TOOL_BROWSER_SHOT,
  TOOL_BROWSER_TYPE,
  TOOL_BROWSER_WAIT,
  allowed,
  canGo,
  clickRef,
  describeViews,
  evalInPage,
  hoverRef,
  navigate,
  pickGuest,
  pressKey,
  readPage,
  scrollPage,
  serveGuest,
  setField,
  shootPage,
  typeInto,
  waitFor,
  waitForLoad,
  type Go,
  type Guest,
} from "./browser"

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
    "List what is open in Zyvro Studio: its windows, with their id and size, and the test browser views with their id, address and title. " +
    "Pass a window id to zyvro_screenshot, or a view id to any zyvro_browser_ tool.",
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

// ---- le navigateur de test ---------------------------------------------
//
// Six outils, et pas un de plus : ouvrir, lire, cliquer, écrire, photographier,
// relire les journaux. C'est la boucle entière de « vérifie que ma page
// marche », et chaque outil de plus est un outil que le modèle doit choisir.
//
// La lecture rend du texte plutôt qu'une image : une capture coûte des milliers
// de jetons et ne dit pas ce qui est cliquable. Elle nomme les éléments (`e1`,
// `e2`…), et c'est par ces noms qu'on clique — donc une page qui a changé rend
// des noms qui ne désignent plus rien, ce qui est exactement ce qu'il faut
// qu'il arrive.

export const browserOpenTool = {
  name: TOOL_BROWSER_OPEN,
  description:
    "Open a page in Zyvro Studio's own test browser — a tab inside the IDE, with its own session, so it never touches the user's browser or their logins. " +
    "Goes to localhost, to origins the user opened themselves in that tab, and to those listed in the project's .zyvro/browser.json. " +
    "Pass go instead of url to move through this tab's history.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      url: { type: "string", description: "http or https address to open." },
      go: { type: "string", enum: ["back", "forward", "reload"], description: "Move in history instead of opening an address." },
      wait_seconds: { type: "number", description: "How long to wait for the page to finish loading. Default 15." },
    },
  },
  annotations: { title: "Open a page", readOnlyHint: false, openWorldHint: true },
}

export const browserReadTool = {
  name: TOOL_BROWSER_READ,
  description:
    "Read the page open in the test browser: its address, title, visible text, and the elements you can click or type into, each with a ref like e12. " +
    "Read again after anything that changes the page — the refs belong to the page as it was.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      match: {
        type: "string",
        description: "Only return elements whose text, value or link contains this. Cheaper than reading a whole catalogue page.",
      },
    },
  },
  annotations: { title: "Read the page", readOnlyHint: true, openWorldHint: false },
}

export const browserClickTool = {
  name: TOOL_BROWSER_CLICK,
  description:
    "Click an element in the test browser by the ref zyvro_browser_read gave it. Sends a real mouse click, so focus and hover handlers run. " +
    "Set hover to only move the pointer onto it, which is what opens a menu that appears on hover.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      ref: { type: "string", description: "An element ref from zyvro_browser_read, such as e7." },
      hover: { type: "boolean", description: "Move the pointer onto it without clicking. Default false." },
    },
    required: ["ref"],
  },
  annotations: { title: "Click", readOnlyHint: false, openWorldHint: false },
}

export const browserKeyTool = {
  name: TOOL_BROWSER_KEY,
  description:
    "Press a key in the test browser: Escape, Tab, Enter, ArrowDown, Backspace, or a character with modifiers. " +
    "It goes to whatever has focus, so click the field first when it matters.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      key: { type: "string", description: "Escape, Tab, Enter, ArrowDown, Backspace, a, …" },
      modifiers: {
        type: "array",
        items: { type: "string" },
        description: "shift, control, alt, meta — anything else is ignored rather than refused.",
      },
    },
    required: ["key"],
  },
  annotations: { title: "Press a key", readOnlyHint: false, openWorldHint: false },
}

export const browserScrollTool = {
  name: TOOL_BROWSER_SCROLL,
  description:
    "Scroll the page in the test browser, or an element of it. Needed to photograph what is further down, and to trigger what only loads on approach — an infinite list stays empty for whoever never scrolls.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      ref: { type: "string", description: "Scroll inside this element instead of the page." },
      direction: { type: "string", enum: ["up", "down"], description: "Default down." },
      amount: { type: "number", description: "Pixels. Default 600." },
    },
  },
  annotations: { title: "Scroll", readOnlyHint: false, openWorldHint: false },
}

export const browserSetTool = {
  name: TOOL_BROWSER_SET,
  description:
    "Set a field the keyboard cannot reach: choose in a dropdown by its option text, or put a checkbox in a state. " +
    "Say what you want it to be, not what to toggle — a checkbox set twice must end up where you asked.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      ref: { type: "string", description: "An element ref from zyvro_browser_read." },
      text: { type: "string", description: "For a select: the option's text. For a field: the value to put in it." },
      checked: { type: "boolean", description: "For a checkbox or a radio." },
    },
    required: ["ref"],
  },
  annotations: { title: "Set a field", readOnlyHint: false, openWorldHint: false },
}

export const browserWaitTool = {
  name: TOOL_BROWSER_WAIT,
  description:
    "Wait until a text or an element appears in the test browser — or disappears, with gone. " +
    "This is the cure for acting before the page is ready, which is the one real cause of flaky checks.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      text: { type: "string", description: "Wait for this text to appear in the page." },
      ref: { type: "string", description: "Wait for this element, from a previous read." },
      gone: { type: "boolean", description: "Wait for it to disappear instead. Default false." },
      seconds: { type: "number", description: "How long to wait before giving up. Default 10, at most 60." },
    },
  },
  annotations: { title: "Wait for", readOnlyHint: true, openWorldHint: false },
}

export const browserEvalTool = {
  name: TOOL_BROWSER_EVAL,
  description:
    "Run a JavaScript expression in the page and return what it evaluates to, as JSON. The way out when no other tool fits — reading a computed style, a global the app exposes, the contents of a canvas.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      expression: { type: "string", description: "A JavaScript expression, not a statement." },
    },
    required: ["expression"],
  },
  annotations: { title: "Evaluate", readOnlyHint: false, openWorldHint: false },
}

export const browserTypeTool = {
  name: TOOL_BROWSER_TYPE,
  description: "Type into a field in the test browser. The field's current contents are replaced. Set submit to press Enter afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      ref: { type: "string", description: "An element ref from zyvro_browser_read." },
      text: { type: "string" },
      submit: { type: "boolean", description: "Press Enter after typing. Default false." },
    },
    required: ["ref", "text"],
  },
  annotations: { title: "Type", readOnlyHint: false, openWorldHint: false },
}

export const browserShotTool = {
  name: TOOL_BROWSER_SHOT,
  description: "Screenshot the page in the test browser. Returns the image, or writes it to a file when a path is given.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      path: { type: "string", description: "Write the PNG here instead of returning it." },
      ref: { type: "string", description: "Frame on this element instead of the whole page." },
    },
  },
  annotations: { title: "Screenshot the page", readOnlyHint: true, openWorldHint: false },
}

export const browserLogsTool = {
  name: TOOL_BROWSER_LOGS,
  description:
    "The console messages and the failed requests of the page in the test browser, since it was last loaded. " +
    "This is what a broken page says about itself, and it is usually the answer.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        description: "Which browser view, when several are open — an id from zyvro_list_windows, such as browser:2.",
      },
      pattern: { type: "string", description: "Only lines matching this regular expression. A console can be noisy." },
      requests: { type: "boolean", description: "Include every request, not only the ones that failed. Default false." },
    },
  },
  annotations: { title: "Console and failed requests", readOnlyHint: true, openWorldHint: false },
}

export const BROWSER_TOOLS = [
  browserOpenTool,
  browserReadTool,
  browserClickTool,
  browserTypeTool,
  browserKeyTool,
  browserSetTool,
  browserScrollTool,
  browserWaitTool,
  browserShotTool,
  browserLogsTool,
  browserEvalTool,
]

// BrowserHost est ce que le serveur ne peut pas savoir tout seul : où est le
// projet ouvert (pour sa liste d'origines) et comment demander au rendu
// d'ouvrir l'onglet. Absent, les outils du navigateur ne sont pas annoncés :
// un serveur qui annonce un outil qu'il ne peut pas rendre fait perdre un tour
// à chaque agent qui l'essaie.
export type BrowserHost = {
  /** Ouvre (ou révèle) un onglet navigateur et rend la vue quand elle répond.
   *  `view` nomme laquelle : un identifiant, « new », ou rien pour celle qui est
   *  déjà ouverte. */
  open: (win: BrowserWindow, view?: string) => Promise<Guest>
  /** Le dossier du projet de cette fenêtre, pour `.zyvro/browser.json`. */
  projectDir: (win: BrowserWindow) => string | null
}

function text(value: string): ShotResult {
  return { content: [{ type: "text", text: value }] }
}

async function browserCall(
  name: string,
  args: Record<string, unknown>,
  all: BrowserWindow[],
  host: BrowserHost
): Promise<ShotResult> {
  const win = pickWindow(all)
  if (!win) throw new Error("Zyvro Studio is not open")

  // Quelle vue. Nommée, c'est celle-là ; sans nom, celle qu'on vient de servir,
  // parce qu'un agent qui ouvre une page puis la lit parle évidemment de
  // celle-là. Plusieurs vues sans cette mémoire, et le deuxième appel partirait
  // ailleurs sans que rien ne le dise.
  const view = typeof args.view === "string" ? args.view.trim() : ""

  // L'ouverture est le seul outil qui peut créer la vue ; les autres parlent de
  // la page ouverte, et dire « ouvrez-en une » est plus utile que d'en ouvrir
  // une vide.
  if (name === TOOL_BROWSER_OPEN) {
    const patience = typeof args.wait_seconds === "number" ? args.wait_seconds : 15
    const go = typeof args.go === "string" ? (args.go as Go) : null

    if (go) {
      const guest = pickGuest(all, view)
      if (!guest) throw new Error(missingView(view))
      if (!canGo(guest, go)) throw new Error(`nothing to go ${go} to in ${guest.view || "this view"}`)
      navigate(guest, go)
      await waitForLoad(guest.contents, patience)
      return text(await describe(serveGuest(guest)))
    }

    const url = String(args.url ?? "")
    const verdict = allowed(url, {
      visited: pickGuest(all, view)?.visited ?? new Set(),
      projectDir: host.projectDir(win),
    })
    if (!verdict.ok) throw new Error(verdict.why)

    const guest = await host.open(win, view)
    await guest.contents.loadURL(verdict.url)
    await waitForLoad(guest.contents, patience)
    return text(await describe(serveGuest(guest)))
  }

  const guest = pickGuest(all, view)
  if (!guest) throw new Error(missingView(view))
  serveGuest(guest)

  switch (name) {
    case TOOL_BROWSER_READ:
      return text(JSON.stringify(await readPage(guest, typeof args.match === "string" ? args.match : ""), null, 1))
    case TOOL_BROWSER_CLICK: {
      const ref = String(args.ref ?? "")
      if (args.hover === true) {
        await hoverRef(guest, ref)
        return text(`the pointer is on ${ref} — read the page, a menu may have opened`)
      }
      const at = await clickRef(guest, ref)
      await waitForLoad(guest.contents, 10)
      return text(`clicked ${ref} at ${at.x},${at.y} — the page may have changed, read it again`)
    }
    case TOOL_BROWSER_TYPE:
      await typeInto(guest, String(args.ref ?? ""), String(args.text ?? ""), args.submit === true)
      if (args.submit === true) await waitForLoad(guest.contents, 10)
      return text(`typed into ${args.ref}${args.submit === true ? " and pressed Enter" : ""}`)
    case TOOL_BROWSER_KEY: {
      const key = String(args.key ?? "")
      if (!key) throw new Error("say which key")
      pressKey(guest, key, Array.isArray(args.modifiers) ? args.modifiers.map(String) : [])
      await waitForLoad(guest.contents, 5)
      return text(`pressed ${key}`)
    }
    case TOOL_BROWSER_SET: {
      const done = await setField(guest, String(args.ref ?? ""), {
        text: typeof args.text === "string" ? args.text : undefined,
        checked: typeof args.checked === "boolean" ? args.checked : undefined,
      })
      return text(`${args.ref}: ${done}`)
    }
    case TOOL_BROWSER_SCROLL: {
      const where = await scrollPage(guest, {
        ref: typeof args.ref === "string" ? args.ref : undefined,
        direction: args.direction === "up" ? "up" : "down",
        amount: typeof args.amount === "number" ? args.amount : undefined,
      })
      return text(`at ${where.y} of ${where.height}`)
    }
    case TOOL_BROWSER_WAIT:
      return text(
        await waitFor(guest, {
          text: typeof args.text === "string" ? args.text : undefined,
          ref: typeof args.ref === "string" ? args.ref : undefined,
          gone: args.gone === true,
          seconds: typeof args.seconds === "number" ? args.seconds : undefined,
        })
      )
    case TOOL_BROWSER_EVAL: {
      const answer = await evalInPage(guest, String(args.expression ?? "null"))
      return text(JSON.stringify(answer, null, 1) ?? "undefined")
    }
    case TOOL_BROWSER_SHOT: {
      const shot = await shootPage(
        guest,
        typeof args.path === "string" ? args.path : undefined,
        typeof args.ref === "string" ? args.ref : undefined
      )
      if (shot.file) return text(`Wrote the page to ${shot.file}`)
      return { content: [{ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" }] }
    }
    case TOOL_BROWSER_LOGS: {
      // Le filtre est une expression régulière parce qu'une console est
      // bavarde : chercher « \[MyApp\] » coûte une lecture au lieu de deux cents
      // lignes. Une expression illisible ne fait pas échouer l'outil — elle
      // devient du texte à chercher tel quel.
      const raw = typeof args.pattern === "string" ? args.pattern.trim() : ""
      let keep: (line: string) => boolean = () => true
      if (raw) {
        try {
          const rx = new RegExp(raw, "i")
          keep = (line) => rx.test(line)
        } catch {
          keep = (line) => line.toLowerCase().includes(raw.toLowerCase())
        }
      }
      return text(
        JSON.stringify(
          {
            console: guest.console.filter((line) => keep(`${line.level} ${line.text}`)),
            failed: guest.requests.filter((r) => (r.error || r.status >= 400) && keep(r.url)),
            ...(args.requests === true ? { requests: guest.requests.filter((r) => keep(r.url)) } : {}),
          },
          null,
          1
        )
      )
    }
  }
  throw new Error(`no such tool: ${name}`)
}

// describe : ce qu'on répond après une navigation. Le titre et l'adresse — qui
// disent tout de suite si on est où on croyait — et de quoi décider du geste
// suivant sans relire la page entière.
async function describe(guest: Guest): Promise<string> {
  const page = await readPage(guest)
  return (
    `${guest.view ? `${guest.view}: ` : ""}${page.title || "(no title)"} — ${page.url}\n` +
    `${page.elements.length} elements to click or type into` +
    `${page.more_below ? ", and more below the fold" : ""}. Read it for the text.`
  )
}

// missingView : le refus qui dit quoi faire. Nommer une vue fermée et n'avoir
// aucune vue ne se réparent pas de la même façon.
function missingView(view: string): string {
  const open = describeViews()
  if (view) {
    return open.length === 0
      ? `there is no browser view open — call ${TOOL_BROWSER_OPEN} with a url`
      : `no browser view called ${view}. Open: ${open.map((v) => v.view).join(", ")}`
  }
  return `no page open in the test browser — call ${TOOL_BROWSER_OPEN} with a url first`
}

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

// captureRegion prend la photo et s'arrête là.
//
// Elle ne décide plus quoi en faire : la capture ouvre une fenêtre qui demande
// — garder, ou partager — et ces deux-là sont des gestes différents, avec des
// conséquences différentes. L'un reste sur la machine, l'autre publie.
export async function captureRegion(win: BrowserWindow | undefined, rect: unknown): Promise<Buffer> {
  if (!win || win.isDestroyed()) throw new Error("no window to capture")
  const region = cleanRect(rect)
  if (!region) throw new Error("that is not a region")
  const image = await win.webContents.capturePage(region)
  return image.toPNG()
}

// saveShot écrit la capture et l'ouvre.
export function saveShot(png: Buffer, place: { dir: string; open: (file: string) => void; label?: string }): string {
  const file = path.join(place.dir, shotName(place.label))
  mkdirSync(place.dir, { recursive: true })
  writeFileSync(file, png)
  place.open(file)
  return file
}

// shareShot dépose la capture sur le service et rend le lien.
//
// Il n'y a pas de route nouvelle pour ça : `/api/uploads` range déjà une image
// pour un compte et `/content/…` la sert sans demander qui vous êtes. Une
// seconde façon de téléverser une image serait une seconde façon de se tromper.
//
// Et c'est pour ça qu'il faut un compte : ce lien est public, donc ce qui le
// dépose doit avoir un nom. Un dépôt anonyme ferait de ce serveur un
// hébergeur de fichiers pour n'importe qui.
export async function shareShot(
  png: Buffer,
  label: string,
  post: (path: string, init: { method: string; body: FormData }) => Promise<unknown>
): Promise<string> {
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), shotName(label))
  const answer = (await post("/api/uploads", { method: "POST", body: form })) as { url?: unknown }
  const url = typeof answer?.url === "string" ? answer.url.trim() : ""
  if (!url) throw new Error("the server accepted the image but returned no link")
  return url
}

// shotName : la zone et l'heure, dans un nom qu'on peut trier.
//
// Un nom fixe écraserait la capture précédente, et c'est toujours celle qu'on
// voulait garder.
export function shotName(label?: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const zone = (label ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `zyvro-${zone ? `${zone}-` : ""}${stamp}.png`
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

export async function startShotsServer(
  windows: () => BrowserWindow[],
  browser?: BrowserHost
): Promise<Handle> {
  if (running) return running
  const token = randomBytes(24).toString("hex")

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, token, windows, browser)
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
  windows: () => BrowserWindow[],
  browser?: BrowserHost
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }))
    return
  }
  let body = ""
  for await (const chunk of req) body += chunk
  let msg: { id?: unknown; method?: string; params?: { name?: string; arguments?: ShotArgs & Record<string, unknown> } }
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
        reply({ tools: [listWindowsTool, screenshotTool, ...(browser ? BROWSER_TOOLS : [])] })
        return
      case "tools/call": {
        switch (msg.params?.name) {
          case TOOL_LIST_WINDOWS:
            reply({
              content: [
                {
                  type: "text",
                  // Les fenêtres et les vues ensemble : c'est une seule question
                  // — « qu'est-ce qui est ouvert ? » — et deux outils pour y
                  // répondre en feraient un que personne n'appelle.
                  text: JSON.stringify(
                    { windows: describeWindows(windows()), ...(browser ? { browser_views: describeViews() } : {}) },
                    null,
                    1
                  ),
                },
              ],
            })
            return
          case TOOL_SCREENSHOT:
            reply(await takeShot(windows(), msg.params?.arguments ?? {}))
            return
          default:
            if (browser && BROWSER_TOOLS.some((t) => t.name === msg.params?.name)) {
              reply(
                await browserCall(
                  String(msg.params?.name),
                  (msg.params?.arguments ?? {}) as Record<string, unknown>,
                  windows(),
                  browser
                )
              )
              return
            }
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
