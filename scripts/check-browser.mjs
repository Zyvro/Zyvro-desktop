// Le navigateur de test, exercé sans écran.
//
// Ce qui casse en silence ici :
//
// 1. **La politique.** Un navigateur piloté par un agent qui peut aller
//    n'importe où est un moyen de faire sortir ce qu'il a lu. Trois portes —
//    la boucle locale, ce que la personne a ouvert elle-même, la liste du
//    projet — et rien d'autre. Un fichier illisible ne doit pas en ouvrir une
//    quatrième.
//
// 2. **Le refus muet.** Un garde-fou qui dit non sans dire comment autoriser
//    est un mur. Le message nomme l'origine et le fichier.
//
// 3. **L'ordre des gestes.** Écrire dans un champ sans le sélecter ajoute au
//    lieu de remplacer : la page testée a l'air de mal se comporter, et c'est
//    nous.
//
// 4. **Les journaux d'une autre page.** Une nouvelle page repart vide, sinon
//    un agent lit les erreurs du site d'avant et corrige ce qui n'est pas
//    cassé.
//
//     node scripts/check-browser.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-browser-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {}, BrowserWindow: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/main/browser").replace(/\\/g, "/")}"\n` +
    `export { startShotsServer } from "${path.join(ROOT, "src/main/shots").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const browser = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Une fausse vue : elle retient ce qu'on lui demande d'exécuter et les
// événements d'entrée qu'elle reçoit, ce qui suffit à vérifier l'ordre des
// gestes sans afficher quoi que ce soit.
function fakeContents(id, page = {}) {
  const listeners = new Map()
  return {
    id,
    events: [],
    loaded: [],
    listeners,
    isDestroyed: () => false,
    isLoading: () => false,
    getType: () => "webview",
    on(name, fn) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn])
    },
    off() {},
    // Une page qui ouvre une fenêtre : la vraie vue refuse et charge dans
    // l'onglet. Le faux retient seulement qu'on le lui a demandé.
    setWindowOpenHandler(fn) {
      this.windowOpenHandler = fn
    },
    emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) fn(...args)
    },
    scripts: [],
    navigationHistory: {
      back: 0,
      forward: 0,
      canGoBack: () => page.canGoBack !== false,
      canGoForward: () => page.canGoForward === true,
      goBack() {
        this.back++
      },
      goForward() {
        this.forward++
      },
    },
    getURL: () => page.url || "http://localhost:3000/",
    getTitle: () => page.title || "Ma page",
    reloaded: 0,
    reload() {
      this.reloaded++
    },
    async executeJavaScript(script) {
      this.events.push({ type: "eval" })
      this.scripts.push(script)
      if (page.answer) return page.answer(script)
      if (script.includes("scrollIntoView")) {
        return page.box === undefined ? { x: 20, y: 30, width: 40, height: 10 } : page.box
      }
      if (script.includes("scrollBy")) return { y: 600, height: 4000 }
      return {
        url: "http://localhost:3000/",
        title: "Ma page",
        text: "bonjour",
        truncated: false,
        elements: [],
        scroll: { y: 0, height: 2000, viewport: 800 },
        more_below: true,
      }
    },
    sendInputEvent(event) {
      this.events.push(event)
    },
    insertText(text) {
      this.events.push({ type: "insertText", text })
    },
    async loadURL(url) {
      this.loaded.push(url)
    },
    async capturePage() {
      return { toPNG: () => Buffer.from([1, 2, 3]) }
    },
  }
}

// ---- la politique --------------------------------------------------------
{
  const empty = { visited: new Set(), projectDir: null }
  check("la boucle locale est la porte de tous les jours", browser.allowed("http://localhost:3000/x", empty).ok)
  check("et son adresse numérique aussi", browser.allowed("http://127.0.0.1:5173", empty).ok)
  check("n'importe quel port", browser.allowed("http://localhost:61234", empty).ok)

  const refused = browser.allowed("https://exemple.test/page", empty)
  check("**un site quelconque est refusé**", refused.ok === false)
  check(
    "et le refus dit comment l'autoriser",
    !refused.ok && refused.why.includes("exemple.test") && refused.why.includes(".zyvro/browser.json"),
    refused.why
  )

  // file: donnerait la machine à l'agent, pas une page à vérifier.
  for (const bad of ["file:///etc/passwd", "data:text/html,<b>x", "javascript:alert(1)", "pas une adresse"]) {
    check(`**${bad.slice(0, 22)} est refusé**`, browser.allowed(bad, empty).ok === false)
  }

  // Ce que la personne a ouvert elle-même, et seulement cette origine.
  const visited = { visited: new Set(["https://exemple.test"]), projectDir: null }
  check("ce que la personne a ouvert, l'agent peut le rouvrir", browser.allowed("https://exemple.test/autre", visited).ok)
  check(
    "**et cet accord ne vaut que pour cette origine**",
    browser.allowed("https://ailleurs.test/", visited).ok === false
  )
}

// ---- la liste du projet --------------------------------------------------
{
  const project = path.join(tmpdir(), "zyvro-browser-check-project")
  rmSync(project, { recursive: true, force: true })
  mkdirSync(path.join(project, ".zyvro"), { recursive: true })

  check("sans fichier, rien de plus", browser.projectAllowList(project).length === 0)

  writeFileSync(path.join(project, ".zyvro", "browser.json"), "{ ceci n'est pas du json")
  check("**un fichier illisible n'ouvre aucune porte**", browser.projectAllowList(project).length === 0)
  check(
    "et le site reste refusé",
    browser.allowed("https://exemple.test/", { visited: new Set(), projectDir: project }).ok === false
  )

  writeFileSync(path.join(project, ".zyvro", "browser.json"), JSON.stringify({ allow: ["https://exemple.test"] }))
  check("une origine listée est ouverte", browser.allowed("https://exemple.test/x", { visited: new Set(), projectDir: project }).ok)
  check(
    "une autre ne l'est pas pour autant",
    browser.allowed("https://ailleurs.test/x", { visited: new Set(), projectDir: project }).ok === false
  )
  // Relu à chaque demande : éditer le fichier doit suffire.
  writeFileSync(path.join(project, ".zyvro", "browser.json"), JSON.stringify({ allow: [] }))
  check(
    "**le fichier est relu à chaque demande**",
    browser.allowed("https://exemple.test/x", { visited: new Set(), projectDir: project }).ok === false
  )
  rmSync(project, { recursive: true, force: true })
}

// ---- le registre ---------------------------------------------------------
{
  browser.forgetGuests()
  const contents = fakeContents(11)
  // Quelqu'un attend la vue avant qu'elle existe : c'est le cas normal quand un
  // agent demande une page et que le rendu doit d'abord monter l'onglet.
  const promised = browser.waitForGuest(7, 2000)
  const guest = browser.registerGuest(contents, 7)
  check("**l'attente se dénoue quand la vue s'annonce**", (await promised).id === guest.id)
  check("et la vue se retrouve par sa fenêtre", browser.guestForWindow(7)?.id === 11)
  check("une fenêtre sans vue n'en invente pas", browser.guestForWindow(99) === undefined)

  const refused = await browser.waitForGuest(42, 120).then(() => null, (err) => err)
  check("**une vue qui n'arrive pas finit par le dire**", refused instanceof Error, String(refused))

  contents.emit("console-message", { level: "error", message: "boum", sourceId: "app.js", lineNumber: 12 })
  browser.noteRequest(11, { url: "http://localhost:3000/api", status: 500 })
  check("la console est retenue", guest.console[0]?.text === "boum")
  check("les requêtes ratées aussi", guest.requests[0]?.status === 500)

  // Une nouvelle page repart d'une page blanche.
  contents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true })
  check("**une nouvelle page repart sans les erreurs de l'ancienne**", guest.console.length === 0 && guest.requests.length === 0)

  // Un saut d'ancre n'est pas une nouvelle page.
  contents.emit("console-message", { level: "warn", message: "encore", sourceId: "", lineNumber: 0 })
  contents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true })
  check("un saut dans la même page ne les efface pas", guest.console.length === 1)

  // Une fenêtre demandée par la page reste dans l'onglet plutôt que d'ouvrir
  // une fenêtre de l'application, hors de la vue et hors de la politique.
  const answer = contents.windowOpenHandler?.({ url: "http://localhost:3000/autre" })
  check("**une page ne peut pas ouvrir de fenêtre**", answer?.action === "deny", JSON.stringify(answer))
  check("et le lien s'ouvre quand même, dans la vue", contents.loaded.includes("http://localhost:3000/autre"))

  browser.noteVisit(11, "https://exemple.test/page/1")
  check("une visite de la personne retient l'origine, pas la page", guest.visited.has("https://exemple.test"))
}

// ---- l'ordre des gestes --------------------------------------------------
{
  browser.forgetGuests()
  const contents = fakeContents(12)
  const guest = browser.registerGuest(contents, 1)

  await browser.clickRef(guest, "e3")
  const kinds = contents.events.map((e) => e.type)
  check("**un clic est un vrai clic**", kinds.includes("mouseDown") && kinds.includes("mouseUp"), kinds.join(","))
  check("précédé du survol, comme une souris", kinds.indexOf("mouseMove") < kinds.indexOf("mouseDown"))

  contents.events.length = 0
  await browser.typeInto(guest, "e4", "bonjour", true)
  const typed = contents.events
  const triple = typed.findIndex((e) => e.clickCount === 3)
  const insert = typed.findIndex((e) => e.type === "char")
  check("**on sélectionne avant d'écrire**", triple >= 0 && triple < insert, JSON.stringify(typed.map((e) => e.type)))
  check(
    "**le texte part touche par touche**",
    typed
      .filter((e) => e.type === "char" && e.keyCode !== "\r")
      .map((e) => e.keyCode)
      .join("") === "bonjour",
    JSON.stringify(typed.filter((e) => e.type === "char"))
  )
  check("et « submit » appuie sur Entrée", typed.some((e) => e.keyCode === "Enter"))

  // Une page qui a changé : le ref ne désigne plus rien.
  const gone = browser.registerGuest(fakeContents(13, { box: null }), 2)
  const err = await browser.clickRef(gone, "e9").then(() => null, (e) => e)
  check("**un élément disparu le dit, et dit quoi faire**", err?.message.includes("read it again"), String(err))
}

// ---- une page qui ne répond pas -----------------------------------------
//
// Vu pour de vrai : une page qui navigue côté client remplace son cadre, et
// l'appel parti vers l'ancien ne se règle jamais. L'agent attendait un outil
// qui ne revenait pas. Un outil qui échoue en le disant vaut infiniment mieux.
{
  browser.forgetGuests()
  const mute = fakeContents(20)
  let asked = 0
  mute.executeJavaScript = () => {
    asked++
    return new Promise(() => {})
  }
  const guest = browser.registerGuest(mute, 5)
  const started = Date.now()
  const err = await browser.readPage(guest, "", 200).then(() => null, (e) => e)
  check("**une page muette finit par rendre une erreur**", err instanceof Error, String(err))
  check("qui dit qu'on n'a pas eu de réponse", err?.message.includes("did not answer"), String(err?.message))
  check("et on a réessayé une fois avant d'abandonner", asked === 2, `${asked} tentative(s)`)
  check("sans y passer la journée", Date.now() - started < 5_000, `${Date.now() - started} ms`)

  // Une vue fermée se dit tout de suite, sans attendre quoi que ce soit.
  const closed = fakeContents(21)
  closed.isDestroyed = () => true
  const gone = browser.registerGuest(closed, 6)
  const err2 = await browser.readPage(gone, "", 200).then(() => null, (e) => e)
  check("une vue fermée le dit immédiatement", err2?.message.includes("closed"), String(err2?.message))
}

// ---- les autres gestes ---------------------------------------------------
//
// Ceux qu'un agent qui teste une page demande dès la deuxième minute, et qui
// manquaient à la première version.
{
  browser.forgetGuests()
  const contents = fakeContents(30)
  const guest = browser.registerGuest(contents, 9)

  browser.navigate(guest, "back")
  browser.navigate(guest, "forward")
  browser.navigate(guest, "reload")
  check(
    "**revenir, avancer, recharger**",
    contents.navigationHistory.back === 1 && contents.navigationHistory.forward === 1 && contents.reloaded === 1
  )
  check("et on sait dire qu'il n'y a nulle part où avancer", browser.canGo(guest, "forward") === false)

  contents.events.length = 0
  await browser.hoverRef(guest, "e1")
  check(
    "**le survol survole, et ne clique pas**",
    contents.events.some((e) => e.type === "mouseMove") && !contents.events.some((e) => e.type === "mouseDown")
  )

  contents.events.length = 0
  browser.pressKey(guest, "Escape")
  const escape = contents.events.map((e) => e.type)
  check("**Échap est une vraie touche**", escape.includes("keyDown") && escape.includes("keyUp"))
  check("sans caractère, puisque ce n'en est pas un", !escape.includes("char"))

  contents.events.length = 0
  browser.pressKey(guest, "a", ["meta", "n'importe quoi"])
  const withMods = contents.events.find((e) => e.type === "keyDown")
  check(
    "**un modificateur inventé est jeté, pas transmis**",
    JSON.stringify(withMods.modifiers) === JSON.stringify(["meta"]),
    JSON.stringify(withMods.modifiers)
  )
  check("un modificateur connu passe", browser.cleanModifiers(["Shift", "CTRL"]).join(",") === "shift,ctrl")

  const where = await browser.scrollPage(guest, { direction: "down", amount: 600 })
  check("le défilement dit où on en est", where.y === 600 && where.height === 4000, JSON.stringify(where))
}

// ---- attendre, plutôt que parier ----------------------------------------
//
// Agir avant que la page soit prête est la seule vraie cause d'échec instable.
{
  browser.forgetGuests()
  let visible = false
  const contents = fakeContents(31, { answer: () => visible })
  const guest = browser.registerGuest(contents, 10)

  setTimeout(() => {
    visible = true
  }, 300)
  const seen = await browser.waitFor(guest, { text: "Bonjour", seconds: 5 })
  check("**on attend qu'une chose apparaisse**", seen.includes("there"), seen)

  const never = await browser
    .waitFor(guest, { text: "jamais", gone: true, seconds: 1 })
    .then(() => null, (err) => err)
  check("**et l'attente qui échoue dit quoi faire**", never?.message.includes("read the page"), String(never?.message))
  check("sans ref ni texte, on refuse plutôt que d'attendre pour rien",
    await browser.waitFor(guest, {}).then(() => false, () => true))
}

// ---- ce qu'un clic ne sait pas faire ------------------------------------
{
  browser.forgetGuests()
  const contents = fakeContents(32, { answer: (script) => (script.includes("SELECT") ? "value=fr" : null) })
  const guest = browser.registerGuest(contents, 11)
  const done = await browser.setField(guest, "e2", { text: "Français" })
  check("**une liste déroulante se choisit par le texte de l'option**", done === "value=fr", done)
  check(
    "et la page est prévenue du changement",
    contents.scripts.some((x) => x.includes('dispatchEvent(new Event("change"'))
  )

  const absent = fakeContents(33, { answer: () => null })
  const gone = browser.registerGuest(absent, 12)
  const err = await browser.setField(gone, "e9", { checked: true }).then(() => null, (e) => e)
  check("un élément disparu le dit", err?.message.includes("read it again"), String(err?.message))
}

// ---- la porte de sortie --------------------------------------------------
{
  browser.forgetGuests()
  const contents = fakeContents(34, { answer: () => ({ width: 1280 }) })
  const guest = browser.registerGuest(contents, 13)
  const answer = await browser.evalInPage(guest, "innerWidth")
  check("**une expression rend ce que JSON sait porter**", answer.width === 1280, JSON.stringify(answer))
  check(
    "**et une promesse est attendue, pas sérialisée telle quelle**",
    contents.scripts.at(-1).startsWith("(async") && contents.scripts.at(-1).includes("await ("),
    contents.scripts.at(-1)?.slice(0, 60)
  )
  check(
    "et l'expression part telle quelle",
    contents.scripts.some((x) => x.includes("innerWidth")),
    contents.scripts.at(-1)?.slice(0, 60)
  )
}

// ---- plusieurs vues ------------------------------------------------------
//
// On en ouvre plusieurs — la page qu'on teste, celle de connexion, la version
// en ligne à comparer. Le risque est qu'un agent en pilote une autre que celle
// qu'il croit, et rien dans la réponse ne le dirait.
{
  browser.forgetGuests()
  const one = browser.registerGuest(fakeContents(40), 20, "browser:1")
  const two = browser.registerGuest(fakeContents(41), 20, "browser:2")

  check("**une vue nommée est celle qu'on obtient**", browser.pickGuest([], "browser:2")?.id === two.id)
  check("un nom inconnu ne se rabat pas sur une autre", browser.pickGuest([], "browser:9") === undefined)

  // La mémoire de la dernière servie : un agent qui ouvre puis lit parle de la
  // même page, et ne devrait pas avoir à la nommer à chaque appel.
  browser.serveGuest(one)
  check("**sans nom, c'est la dernière servie**", browser.pickGuest([])?.id === one.id)
  browser.serveGuest(two)
  check("et elle suit ce qu'on vient de faire", browser.pickGuest([])?.id === two.id)

  const listed = browser.describeViews()
  check("la liste nomme les deux", listed.map((v) => v.view).join(",") === "browser:1,browser:2", JSON.stringify(listed))
  check("et dit laquelle est servie", listed.find((v) => v.serving)?.view === "browser:2")
}

// ---- les outils, par le serveur -----------------------------------------
{
  browser.forgetGuests()
  const contents = fakeContents(14)
  const guest = browser.registerGuest(contents, 3)
  const win = { id: 3, isDestroyed: () => false, isFocused: () => true, webContents: { capturePage: async () => ({ toPNG: () => Buffer.from([0]) }) } }

  const handle = await browser.startShotsServer(() => [win], {
    open: async () => guest,
    projectDir: () => null,
  })
  const call = (name, args = {}) =>
    fetch(handle.origin, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ id: 1, method: "tools/call", params: { name, arguments: args } }),
    }).then((r) => r.json())

  const listed = await fetch(handle.origin, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.token}` },
    body: JSON.stringify({ id: 1, method: "tools/list" }),
  }).then((r) => r.json())
  const names = listed.result.tools.map((t) => t.name)
  check(
    "**tous les outils du navigateur sont annoncés**",
    ["open", "read", "click", "type", "key", "set", "scroll", "wait", "screenshot", "logs", "eval"].every((n) =>
      names.includes(`zyvro_browser_${n}`)
    ),
    names.join(", ")
  )
  check("et la capture d'écran de l'app est toujours là", names.includes("zyvro_screenshot"))

  const evil = await call("zyvro_browser_open", { url: "https://exemple.test" })
  check("**une adresse refusée revient en erreur d'outil**", evil.result.isError === true)
  check("sans que la vue ait bougé", contents.loaded.length === 0)

  const ok = await call("zyvro_browser_open", { url: "http://localhost:3000" })
  check("la boucle locale s'ouvre", contents.loaded[0] === "http://localhost:3000/", contents.loaded.join(","))
  check("et la réponse nomme la page", ok.result.content[0].text.includes("Ma page"), JSON.stringify(ok.result))

  const logs = await call("zyvro_browser_logs")
  check("les journaux reviennent en texte lisible", logs.result.content[0].text.includes("console"))

  handle.close()
}

console.log(
  failures === 0
    ? "\nL'agent a son navigateur, il ne va que là où on l'a laissé aller, et ce qu'il clique est vraiment cliqué."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
