import type { BrowserWindow, WebContents } from "electron"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

// Un navigateur de test dans l'IDE, que l'agent pilote.
//
// Pourquoi : un agent qui vérifie son travail dans le navigateur de la personne
// clique dans les onglets de quelqu'un, dans sa session, avec ses cookies. On
// lui donne donc le sien — un onglet de plus dans l'application, avec sa propre
// session, que la personne voit travailler.
//
// Pourquoi c'est possible sans rien télécharger : Electron *est* Chromium. La
// vue est une `<webview>`, donc un `WebContents` à part entière : elle navigue
// pour de vrai, elle exécute le JavaScript de la page, et le processus
// principal peut lui envoyer des événements d'entrée natifs. Pas de binaire en
// plus dans l'installeur, pas de second navigateur à gérer.
//
// Ce que ce fichier contient : la politique (où l'agent a le droit d'aller), le
// registre des vues ouvertes, et les gestes — lire, cliquer, écrire,
// photographier, relire les journaux. Les outils MCP qui les appellent vivent
// dans shots.ts, avec le serveur qui les sert déjà.

export const BROWSER_PARTITION = "persist:zyvro-browser"

export const TOOL_BROWSER_OPEN = "zyvro_browser_open"
export const TOOL_BROWSER_READ = "zyvro_browser_read"
export const TOOL_BROWSER_CLICK = "zyvro_browser_click"
export const TOOL_BROWSER_TYPE = "zyvro_browser_type"
export const TOOL_BROWSER_SHOT = "zyvro_browser_screenshot"
export const TOOL_BROWSER_LOGS = "zyvro_browser_logs"

// ---- la politique -------------------------------------------------------
//
// Un navigateur piloté par un agent qui peut aller n'importe où est aussi un
// moyen de faire sortir ce qu'il a lu. Trois portes, et rien d'autre :
//
//   1. La boucle locale. C'est l'usage : « vérifie que ma page marche ».
//   2. Ce que la personne a ouvert elle-même dans cet onglet. Taper une adresse
//      dans la barre est un accord explicite, pour cette origine.
//   3. Une liste dans `.zyvro/browser.json`, versionnée avec le projet, donc
//      lisible et relue comme le reste du dépôt.
//
// Ce que ça n'attrape pas, et il vaut mieux le dire : une page autorisée peut
// emmener ailleurs par un clic sur un lien. La politique tient les adresses que
// l'agent demande, pas ce qu'une page décide ensuite.

export type Policy = {
  /** Les origines que la personne a ouvertes elle-même, cette session. */
  visited: Set<string>
  /** `.zyvro/browser.json`, relu à chaque demande : l'éditer doit suffire. */
  projectDir: string | null
}

export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0"
}

// allowFile est la liste du projet. Absente ou illisible vaut « rien de plus »,
// jamais « tout » : un fichier qu'on n'arrive pas à lire ne doit pas ouvrir des
// portes.
export function projectAllowList(projectDir: string | null): string[] {
  if (!projectDir) return []
  try {
    const raw = readFileSync(path.join(projectDir, ".zyvro", "browser.json"), "utf8")
    const parsed = JSON.parse(raw) as { allow?: unknown }
    if (!Array.isArray(parsed.allow)) return []
    return parsed.allow.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export function originOf(url: string): string {
  return new URL(url).origin
}

// allowed dit si l'agent peut demander cette adresse, et sinon pourquoi.
//
// Le message est la moitié du travail : un refus qui ne dit pas comment
// autoriser transforme un garde-fou en mur.
export function allowed(url: string, policy: Policy): { ok: true; url: string } | { ok: false; why: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, why: `"${url}" is not an address` }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // file:, data:, javascript: — un navigateur qui les suit sur demande d'un
    // agent lui donne la machine, et pas une page à vérifier.
    return { ok: false, why: `${parsed.protocol} is not allowed here — the test browser opens http and https only` }
  }
  if (isLoopback(parsed.hostname)) return { ok: true, url: parsed.toString() }

  const origin = parsed.origin
  if (policy.visited.has(origin)) return { ok: true, url: parsed.toString() }

  const list = projectAllowList(policy.projectDir)
  if (list.includes(origin) || list.includes("*")) return { ok: true, url: parsed.toString() }

  return {
    ok: false,
    why:
      `${origin} is not open to the agent. The test browser goes to localhost, to what you opened yourself in ` +
      `its address bar, and to the origins listed in .zyvro/browser.json — {"allow": ["${origin}"]}.`,
  }
}

// ---- les vues ouvertes --------------------------------------------------

export type LogLine = { level: string; text: string; source?: string; line?: number }
export type RequestLine = { url: string; status: number; error?: string }

export type Guest = {
  /** L'identifiant du WebContents de la vue, tel que le rendu le donne. */
  id: number
  contents: WebContents
  windowId: number
  console: LogLine[]
  requests: RequestLine[]
  visited: Set<string>
}

// KEPT borne ce qu'on garde : une page bavarde écrit des milliers de lignes, et
// un agent n'en lira jamais que la fin.
const KEPT = 200

const guests = new Map<number, Guest>()

// Qui attend qu'une vue s'ouvre. L'agent demande une page, le processus
// principal demande l'onglet au rendu, et le rendu met une image ou deux à
// monter la vue : sans ce rendez-vous, la navigation partirait vers une vue qui
// n'existe pas encore, et l'agent lirait « pas de page ouverte » juste après
// avoir demandé qu'on en ouvre une.
const waiting = new Map<number, Array<(guest: Guest) => void>>()

export function registerGuest(contents: WebContents, windowId: number): Guest {
  const existing = guests.get(contents.id)
  if (existing) return existing

  const guest: Guest = { id: contents.id, contents, windowId, console: [], requests: [], visited: new Set() }
  guests.set(contents.id, guest)

  const promised = waiting.get(windowId)
  if (promised) {
    waiting.delete(windowId)
    for (const resolve of promised) resolve(guest)
  }

  contents.on("console-message", (event) => {
    push(guest.console, {
      level: String(event.level ?? "info"),
      text: String(event.message ?? ""),
      source: event.sourceId,
      line: event.lineNumber,
    })
  })
  // Une nouvelle page repart d'une page blanche : les erreurs d'avant
  // n'expliquent rien de celle-ci, et un agent qui relit les journaux après une
  // navigation lirait les problèmes du site précédent.
  contents.on("did-start-navigation", (event) => {
    if (event.isSameDocument || !event.isMainFrame) return
    guest.console.length = 0
    guest.requests.length = 0
  })
  // Une page qui ouvre une fenêtre ouvrirait une fenêtre de l'application, hors
  // de l'onglet et hors de la politique. Les liens `target="_blank"` restent
  // donc dans la vue, ce qui est aussi ce qu'on veut en la regardant.
  contents.setWindowOpenHandler(({ url }) => {
    void contents.loadURL(url).catch(() => {})
    return { action: "deny" }
  })

  contents.on("destroyed", () => guests.delete(guest.id))

  return guest
}

export function noteRequest(guestId: number, line: RequestLine): void {
  const guest = guests.get(guestId)
  if (guest) push(guest.requests, line)
}

// noteVisit enregistre ce que la personne a ouvert elle-même. C'est l'accord
// explicite dont la politique parle, et il ne vaut que pour cette origine.
export function noteVisit(guestId: number, url: string): void {
  const guest = guests.get(guestId)
  if (!guest) return
  try {
    guest.visited.add(originOf(url))
  } catch {
    // Une adresse que l'URL ne sait pas lire n'ouvre aucune porte.
  }
}

function push<T>(list: T[], line: T): void {
  list.push(line)
  if (list.length > KEPT) list.splice(0, list.length - KEPT)
}

// pickGuest choisit la vue à piloter : celle de la fenêtre au premier plan,
// comme la capture d'écran choisit sa fenêtre.
export function pickGuest(all: BrowserWindow[]): Guest | undefined {
  const open = [...guests.values()].filter((g) => !g.contents.isDestroyed())
  if (open.length <= 1) return open[0]
  const focused = all.find((w) => !w.isDestroyed() && w.isFocused())
  return (focused && open.find((g) => g.windowId === focused.id)) ?? open[0]
}

export function guestForWindow(windowId: number): Guest | undefined {
  return [...guests.values()].find((g) => g.windowId === windowId && !g.contents.isDestroyed())
}

// waitForGuest attend que le rendu ait monté la vue de cette fenêtre.
//
// Il échoue plutôt que d'attendre indéfiniment : une fenêtre qui n'ouvre pas
// l'onglet est un bug, et un agent bloqué sans rien dire est pire qu'un agent
// qui rapporte l'échec.
export function waitForGuest(windowId: number, ms = 10_000): Promise<Guest> {
  const open = guestForWindow(windowId)
  if (open) return Promise.resolve(open)
  return new Promise((resolve, reject) => {
    const list = waiting.get(windowId) ?? []
    const settle = (guest: Guest) => {
      clearTimeout(timer)
      resolve(guest)
    }
    list.push(settle)
    waiting.set(windowId, list)
    const timer = setTimeout(() => {
      const left = (waiting.get(windowId) ?? []).filter((fn) => fn !== settle)
      if (left.length === 0) waiting.delete(windowId)
      else waiting.set(windowId, left)
      reject(new Error("the test browser did not open — is the window still there?"))
    }, ms)
  })
}

export function guestCount(): number {
  return [...guests.values()].filter((g) => !g.contents.isDestroyed()).length
}

export function forgetGuests(): void {
  guests.clear()
}

// ---- les gestes ---------------------------------------------------------

// REF est l'attribut que la lecture pose sur les éléments qu'on peut viser.
// Il vit dans la page, pas dans un index ici : la page change à chaque clic, et
// un index gardé de ce côté désignerait des éléments qui n'existent plus.
const REF = "data-zyvro-ref"

// readScript est ce que la lecture exécute dans la page.
//
// Elle rend du texte, pas une image : une capture coûte des milliers de jetons
// et ne dit pas ce qui est cliquable. L'arbre ici nomme ce qu'on peut viser et
// donne son texte, ce qui suffit à décider du geste suivant.
const readScript = `(() => {
  const seen = []
  let n = 0
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05
  }
  const label = (el) => {
    const own = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText || el.getAttribute("title") || "").trim()
    return own.replace(/\\s+/g, " ").slice(0, 120)
  }
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]')) {
    if (!visible(el)) continue
    const ref = "e" + ++n
    el.setAttribute(${JSON.stringify(REF)}, ref)
    seen.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      text: label(el),
      // Ce que le champ contient, à part de son nom. Sans ça, un champ dont le
      // texte affiché est son *placeholder* a l'air vide après qu'on y a écrit,
      // et l'agent réécrit — ou conclut que l'écriture n'a pas marché.
      value: typeof el.value === "string" ? el.value.slice(0, 120) : undefined,
      href: el.getAttribute("href") || undefined,
    })
    if (n >= 120) break
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim()
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 6000),
    truncated: text.length > 6000,
    elements: seen,
  }
})()`

export type Snapshot = {
  url: string
  title: string
  text: string
  truncated: boolean
  elements: Array<{ ref: string; tag: string; type?: string; text: string; value?: string; href?: string }>
}

// inPage exécute dans la page, et répond toujours.
//
// Deux choses arrivent pour de vrai, vues sur la boutique servie en local :
//
//   · Une page qui navigue côté client remplace son cadre de rendu. L'appel
//     part vers un cadre qui vient de disparaître, Electron l'écrit sur la
//     sortie d'erreur — « Render frame was disposed » — et la promesse ne se
//     règle jamais. L'outil, lui, n'avait plus qu'à attendre : l'agent restait
//     bloqué sur un appel qui ne revenait pas.
//   · Une page qui boucle en JavaScript ne rend jamais la main.
//
// Donc : une limite de temps, et une seconde tentative après un souffle. Un
// outil qui échoue en le disant vaut infiniment mieux qu'un outil qui attend.
// Huit secondes : une page qui n'a rien dit d'ici là ne dira rien d'utile, et
// l'agent a besoin d'une réponse, pas d'une attente.
const PAGE_ANSWER_MS = 8000

function limit<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`the page did not answer in ${Math.round(ms / 1000)}s — is it still loading?`)), ms)
    ),
  ])
}

async function inPage<T>(guest: Guest, script: string, ms = PAGE_ANSWER_MS): Promise<T> {
  if (guest.contents.isDestroyed()) throw new Error("the test browser was closed")
  try {
    return (await limit(guest.contents.executeJavaScript(script, true), ms)) as T
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (guest.contents.isDestroyed()) throw new Error("the test browser was closed")
    return (await limit(guest.contents.executeJavaScript(script, true), ms)) as T
  }
}

export async function readPage(guest: Guest, ms?: number): Promise<Snapshot> {
  return await inPage<Snapshot>(guest, readScript, ms)
}

type Box = { x: number; y: number; width: number; height: number } | null

// boxOf demande à la page où est l'élément, après l'avoir amené à l'écran : un
// clic aux coordonnées d'un élément hors du cadre atterrit sur autre chose.
async function boxOf(guest: Guest, ref: string): Promise<Box> {
  const script = `(() => {
    const el = document.querySelector('[${REF}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')
    if (!el) return null
    el.scrollIntoView({ block: "center", inline: "center" })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height }
  })()`
  return await inPage<Box>(guest, script)
}

function missing(ref: string): Error {
  return new Error(`no element ${ref} on this page — read it again, the page has changed since`)
}

// clickAt envoie un vrai clic plutôt que d'appeler `el.click()`.
//
// La différence se voit sur exactement ce qu'on veut tester : le focus, les
// événements de survol, les gestionnaires qui écoutent `mousedown`, les menus
// qui se ferment sur un clic ailleurs. Une page où `el.click()` marche et où le
// clic réel ne marche pas est une page cassée, et c'est celle-là qu'il faut
// voir.
export async function clickRef(guest: Guest, ref: string): Promise<{ x: number; y: number }> {
  const box = await boxOf(guest, ref)
  if (!box) throw missing(ref)
  const point = { x: Math.round(box.x), y: Math.round(box.y) }
  guest.contents.sendInputEvent({ type: "mouseMove", ...point })
  guest.contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 })
  guest.contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 })
  return point
}

export async function typeInto(
  guest: Guest,
  ref: string,
  text: string,
  submit = false
): Promise<void> {
  const box = await boxOf(guest, ref)
  if (!box) throw missing(ref)
  const point = { x: Math.round(box.x), y: Math.round(box.y) }
  // Trois clics : le champ prend le focus et son contenu est sélectionné, donc
  // la frappe remplace au lieu d'ajouter. Écrire « bonjour » dans un champ qui
  // contenait déjà quelque chose donnait « quelque chosebonjour », et la page
  // testée avait l'air de mal se comporter.
  guest.contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 3 })
  guest.contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 3 })
  // Caractère par caractère, et pas `insertText` : vérifié sur la boutique
  // servie en local, `insertText` laissait le champ vide alors que le clic
  // l'avait bien mis au premier plan. Une frappe est de toute façon ce qu'on
  // veut tester — un champ qui réagit à chaque touche, une recherche qui part
  // à la troisième lettre, un formulaire qui se valide en tapant.
  for (const character of text) {
    guest.contents.sendInputEvent({ type: "char", keyCode: character })
  }
  if (submit) {
    guest.contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" })
    guest.contents.sendInputEvent({ type: "char", keyCode: "\r" })
    guest.contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" })
  }
}

export async function shootPage(guest: Guest, target?: string): Promise<{ png: Buffer; file?: string }> {
  const image = await guest.contents.capturePage()
  const png = image.toPNG()
  const file = (target ?? "").trim()
  if (!file) return { png }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, png)
  return { png, file }
}

// waitForLoad attend que la page ait fini de charger, avec une limite.
//
// Sans elle, l'agent lit une page blanche et conclut que son application est
// cassée : `loadURL` rend la main à la première réponse, pas au premier rendu.
export function waitForLoad(contents: WebContents, seconds = 15): Promise<void> {
  return new Promise((resolve) => {
    if (!contents.isLoading()) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      contents.off("did-stop-loading", done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(1, seconds) * 1000)
    contents.on("did-stop-loading", done)
  })
}
