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
export const TOOL_BROWSER_KEY = "zyvro_browser_key"
export const TOOL_BROWSER_SCROLL = "zyvro_browser_scroll"
export const TOOL_BROWSER_SET = "zyvro_browser_set"
export const TOOL_BROWSER_WAIT = "zyvro_browser_wait"
export const TOOL_BROWSER_EVAL = "zyvro_browser_eval"

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
  /** L'identifiant de l'onglet — « browser:2 » — qu'un agent emploie pour dire
   *  laquelle il pilote, et que la barre latérale affiche. */
  view: string
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

export function registerGuest(contents: WebContents, windowId: number, view = ""): Guest {
  const existing = guests.get(contents.id)
  if (existing) return existing

  const guest: Guest = { id: contents.id, view, contents, windowId, console: [], requests: [], visited: new Set() }
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

// lastServed est la vue sur laquelle un outil a agi en dernier.
//
// C'est ce qui rend l'absence de `view` utilisable : un agent qui ouvre une
// page puis la lit, la clique et la photographie parle évidemment de celle-là.
// Sans cette mémoire, « la première ouverte » l'enverrait ailleurs dès la
// deuxième vue, et rien dans la réponse ne le dirait.
let lastServed = ""

export function openViews(): Guest[] {
  return [...guests.values()].filter((g) => !g.contents.isDestroyed())
}

// pickGuest choisit la vue à piloter : celle qu'on nomme, sinon la dernière
// servie, sinon la seule qu'il y ait.
export function pickGuest(all: BrowserWindow[], view = ""): Guest | undefined {
  const open = openViews()
  const wanted = view.trim()
  if (wanted) {
    const named = open.find((g) => g.view === wanted)
    if (named) lastServed = named.view
    return named
  }
  const recent = open.find((g) => g.view === lastServed)
  if (recent) return recent
  if (open.length <= 1) return open[0]
  const focused = all.find((w) => !w.isDestroyed() && w.isFocused())
  return (focused && open.find((g) => g.windowId === focused.id)) ?? open[0]
}

export function serveGuest(guest: Guest): Guest {
  lastServed = guest.view
  return guest
}

// describeViews : ce que l'agent doit savoir pour en nommer une.
export function describeViews(): Array<Record<string, unknown>> {
  return openViews().map((g) => ({
    view: g.view,
    url: g.contents.getURL(),
    title: g.contents.getTitle(),
    serving: g.view === lastServed,
  }))
}

export function guestForWindow(windowId: number): Guest | undefined {
  return [...guests.values()].find((g) => g.windowId === windowId && !g.contents.isDestroyed())
}

// waitForGuest attend que le rendu ait monté la vue de cette fenêtre.
//
// Il échoue plutôt que d'attendre indéfiniment : une fenêtre qui n'ouvre pas
// l'onglet est un bug, et un agent bloqué sans rien dire est pire qu'un agent
// qui rapporte l'échec.
export function waitForGuest(windowId: number, ms = 10_000, fresh = false): Promise<Guest> {
  // `fresh` attend celle qui n'existe pas encore : quand un agent demande une
  // vue de plus, rendre celle qui est déjà là lui ferait piloter la page que la
  // personne est en train de lire.
  const open = fresh ? undefined : guestForWindow(windowId)
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
  lastServed = ""
}

// ---- les gestes ---------------------------------------------------------

// REF est l'attribut que la lecture pose sur les éléments qu'on peut viser.
// Il vit dans la page, pas dans un index ici : la page change à chaque clic, et
// un index gardé de ce côté désignerait des éléments qui n'existent plus.
const REF_ATTR = "data-zyvro-ref"

// readScriptFor est ce que la lecture exécute dans la page.
//
// Elle rend du texte, pas une image : une capture coûte des milliers de jetons
// et ne dit pas ce qui est cliquable. L'arbre ici nomme ce qu'on peut viser et
// donne son texte, ce qui suffit à décider du geste suivant.
//
// `match` réduit la liste à ce qu'on cherche. Sur une page de catalogue, cent
// vingt éléments sont cent vingt lignes dont l'agent lit une : chercher « panier »
// coûte une lecture au lieu de trois.
function readScriptFor(match: string): string {
  return `(() => {
  const wanted = ${JSON.stringify(match.toLowerCase())}
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
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [onclick], [contenteditable="true"]')) {
    if (!visible(el)) continue
    const ref = "e" + ++n
    el.setAttribute(${JSON.stringify(REF_ATTR)}, ref)
    const text = label(el)
    const value = typeof el.value === "string" ? el.value.slice(0, 120) : undefined
    if (wanted && !((text + " " + (value || "") + " " + (el.getAttribute("href") || "")).toLowerCase().includes(wanted))) continue
    const box = el.getBoundingClientRect()
    seen.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || undefined,
      text,
      // Ce que le champ contient, à part de son nom. Sans ça, un champ dont le
      // texte affiché est son *placeholder* a l'air vide après qu'on y a écrit,
      // et l'agent réécrit — ou conclut que l'écriture n'a pas marché.
      value,
      checked: typeof el.checked === "boolean" ? el.checked : undefined,
      disabled: el.disabled === true ? true : undefined,
      // Ce qui est hors de l'écran demande un défilement avant d'être
      // photographié ; cliquable, ça l'est de toute façon.
      offscreen: box.bottom < 0 || box.top > innerHeight ? true : undefined,
      options: el.tagName === "SELECT" ? Array.from(el.options).map((o) => o.text).slice(0, 30) : undefined,
      href: el.getAttribute("href") || undefined,
    })
    if (seen.length >= 120) break
  }
  const whole = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim()
  // Quand on cherche quelque chose de précis, le texte entier de la page est
  // exactement ce qu'on essayait de ne pas payer : il reste, en plus court.
  const room = wanted ? 800 : 6000
  return {
    url: location.href,
    title: document.title,
    text: whole.slice(0, room),
    truncated: whole.length > room,
    elements: seen,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(innerHeight) },
    more_below: scrollY + innerHeight < document.documentElement.scrollHeight - 4,
  }
})()`
}

export type Snapshot = {
  url: string
  title: string
  text: string
  truncated: boolean
  elements: Array<{
    ref: string
    tag: string
    type?: string
    text: string
    value?: string
    checked?: boolean
    disabled?: boolean
    offscreen?: boolean
    options?: string[]
    href?: string
  }>
  scroll: { y: number; height: number; viewport: number }
  more_below: boolean
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

export async function readPage(guest: Guest, match = "", ms?: number): Promise<Snapshot> {
  return await inPage<Snapshot>(guest, readScriptFor(match), ms)
}

type Box = { x: number; y: number; width: number; height: number } | null

// boxOf demande à la page où est l'élément, après l'avoir amené à l'écran : un
// clic aux coordonnées d'un élément hors du cadre atterrit sur autre chose.
async function boxOf(guest: Guest, ref: string): Promise<Box> {
  const script = `(() => {
    const el = document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')
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

// ---- les autres gestes --------------------------------------------------
//
// Ce qui a été ajouté après coup, parce qu'un agent qui teste une page les
// demande dès la deuxième minute : revenir en arrière, attendre que quelque
// chose apparaisse, appuyer sur Échap, survoler un menu, descendre dans la
// page, choisir dans une liste déroulante.

export type Go = "back" | "forward" | "reload"

export function navigate(guest: Guest, go: Go): void {
  if (go === "back") guest.contents.navigationHistory.goBack()
  else if (go === "forward") guest.contents.navigationHistory.goForward()
  else guest.contents.reload()
}

export function canGo(guest: Guest, go: Go): boolean {
  if (go === "back") return guest.contents.navigationHistory.canGoBack()
  if (go === "forward") return guest.contents.navigationHistory.canGoForward()
  return true
}

// hover est le geste des menus qui s'ouvrent au survol, et de rien d'autre.
// Sans lui, le sous-menu n'existe pas dans la page et l'agent conclut que le
// lien qu'il cherche n'y est pas.
export async function hoverRef(guest: Guest, ref: string): Promise<void> {
  const box = await boxOf(guest, ref)
  if (!box) throw missing(ref)
  guest.contents.sendInputEvent({ type: "mouseMove", x: Math.round(box.x), y: Math.round(box.y) })
}

// pressKey : une touche, avec ses modificateurs. Échap ferme, Tab passe au
// champ suivant, les flèches parcourent une liste — aucune de ces choses ne se
// fait au clic, et toutes décident de ce qu'une page montre ensuite.
// MODIFIERS : ceux qu'Electron reconnaît. Un nom inventé n'est pas ignoré, il
// fait refuser l'événement entier, donc on ne laisse passer que ceux-là.
const MODIFIERS = ["shift", "control", "ctrl", "alt", "meta", "command", "cmd", "capslock", "numlock"] as const
type Modifier = (typeof MODIFIERS)[number]

export function cleanModifiers(raw: string[]): Modifier[] {
  return raw
    .map((m) => m.toLowerCase().trim())
    .filter((m): m is Modifier => (MODIFIERS as readonly string[]).includes(m))
}

export function pressKey(guest: Guest, key: string, modifiers: string[] = []): void {
  const mods = cleanModifiers(modifiers)
  guest.contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers: mods })
  // Un caractère imprimable demande aussi l'événement `char` : sans lui, la
  // touche est vue mais rien ne s'écrit.
  if (key.length === 1 && mods.length === 0) guest.contents.sendInputEvent({ type: "char", keyCode: key })
  guest.contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers: mods })
}

// scrollPage descend ou remonte, dans la page ou dans un élément.
//
// Nécessaire pour deux choses : photographier ce qui est plus bas, et déclencher
// ce qui ne charge qu'en approchant — une liste infinie reste vide pour qui ne
// descend jamais.
export async function scrollPage(
  guest: Guest,
  what: { ref?: string; direction?: "up" | "down"; amount?: number }
): Promise<{ y: number; height: number }> {
  const step = Math.round(what.amount && what.amount > 0 ? what.amount : 600) * (what.direction === "up" ? -1 : 1)
  const target = what.ref
    ? `document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(what.ref))} + ']')`
    : "null"
  const script = `(() => {
    const el = ${target}
    if (el) el.scrollBy(0, ${step})
    else scrollBy(0, ${step})
    return { y: Math.round(el ? el.scrollTop : scrollY), height: Math.round(el ? el.scrollHeight : document.documentElement.scrollHeight) }
  })()`
  return await inPage(guest, script)
}

// setField pour ce qu'un clic ne sait pas faire.
//
// Une liste déroulante native s'ouvre hors de la page — un menu du système — et
// aucun clic synthétique ne la parcourt. Une case à cocher, elle, se coche au
// clic, mais « mets-la à coché » est ce qu'on veut dire, pas « bascule-la » :
// deux appels de suite la laisseraient comme avant.
export async function setField(
  guest: Guest,
  ref: string,
  value: { text?: string; checked?: boolean }
): Promise<string> {
  const script = `(() => {
    const el = document.querySelector('[${REF_ATTR}=' + ${JSON.stringify(JSON.stringify(ref))} + ']')
    if (!el) return null
    if (${JSON.stringify(value.checked !== undefined)}) {
      el.checked = ${JSON.stringify(value.checked === true)}
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return "checked=" + el.checked
    }
    const wanted = ${JSON.stringify(value.text ?? "")}
    if (el.tagName === "SELECT") {
      const option = Array.from(el.options).find((o) => o.text === wanted || o.value === wanted)
      if (!option) return "no-option:" + Array.from(el.options).map((o) => o.text).join(" | ")
      el.value = option.value
    } else {
      // Le passage par le setter natif : une entrée contrôlée par React ignore
      // une écriture directe sur .value, et la page garderait l'ancien texte
      // tout en l'affichant changé.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, "value")
      if (setter && setter.set) setter.set.call(el, wanted)
      else el.value = wanted
    }
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return "value=" + el.value
  })()`
  const answer = await inPage<string | null>(guest, script)
  if (answer === null) throw missing(ref)
  if (answer.startsWith("no-option:")) {
    throw new Error(`no such option — this list offers: ${answer.slice("no-option:".length)}`)
  }
  return answer
}

// waitFor est le remède à la seule vraie cause d'échec instable : agir avant
// que la page soit prête. Attendre un texte ou un élément dit *quoi* attendre,
// là où un délai fixe est un pari qu'on perd une fois sur dix.
export async function waitFor(
  guest: Guest,
  what: { text?: string; ref?: string; gone?: boolean; seconds?: number }
): Promise<string> {
  const limitMs = Math.min(60, Math.max(1, what.seconds ?? 10)) * 1000
  const until = Date.now() + limitMs
  const wantsText = (what.text ?? "").trim()
  const wantsRef = (what.ref ?? "").trim()
  if (!wantsText && !wantsRef) throw new Error("say what to wait for: a text, or an element ref")

  const script = `(() => {
    const text = ${JSON.stringify(wantsText)}
    const ref = ${JSON.stringify(wantsRef)}
    if (ref) return Boolean(document.querySelector('[${REF_ATTR}=' + JSON.stringify(ref) + ']'))
    return (document.body ? document.body.innerText : "").includes(text)
  })()`

  for (;;) {
    const there = await inPage<boolean>(guest, script, 5000)
    if (there === !what.gone) {
      return what.gone ? "it is gone" : "it is there"
    }
    if (Date.now() > until) {
      throw new Error(
        `waited ${Math.round(limitMs / 1000)}s and ${wantsRef || `"${wantsText}"`} is still ${what.gone ? "there" : "missing"} — read the page to see what it shows instead`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// evalInPage est la porte de sortie : ce qu'aucun outil ne prévoit, on le
// demande à la page elle-même. Elle rend ce que JSON sait porter, parce qu'un
// nœud du DOM ne traverse pas le pont et reviendrait en objet vide.
export async function evalInPage(guest: Guest, expression: string): Promise<unknown> {
  // Attendue, et pas seulement évaluée : la moitié de ce qu'on veut demander à
  // une page est une promesse — `navigator.gpu.requestAdapter()`,
  // `fetch(...).then(r => r.json())`, `caches.keys()`. Sérialisée sans être
  // attendue, une promesse revient en objet vide, et l'agent en conclut que la
  // page ne sait pas faire.
  const script = `(async () => {
    const answer = await (${expression})
    try {
      return JSON.parse(JSON.stringify(answer ?? null))
    } catch {
      return String(answer)
    }
  })()`
  return await inPage<unknown>(guest, script)
}

export async function shootPage(
  guest: Guest,
  target?: string,
  ref?: string
): Promise<{ png: Buffer; file?: string }> {
  // Cadrée sur un élément quand on en nomme un : la page entière pour montrer
  // un bouton mal aligné coûte une image de deux mille pixels dont l'agent
  // regarde cinquante.
  let region: { x: number; y: number; width: number; height: number } | undefined
  if (ref) {
    const box = await boxOf(guest, ref)
    if (!box) throw missing(ref)
    region = {
      x: Math.max(0, Math.round(box.x - box.width / 2)),
      y: Math.max(0, Math.round(box.y - box.height / 2)),
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
    }
  }
  const image = await guest.contents.capturePage(region)
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
