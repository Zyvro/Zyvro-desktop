// Ce qu'on écrit au panneau d'agent ne se perd plus, et ce qu'on a envoyé se
// rappelle.
//
// Demandé par Jeremy : un historique des prompts, et « vérifier que même si
// j'ouvre / ferme des panneaux alors que j'ai déjà du texte dans un prompt,
// il ne soit pas perdu ». Le brouillon vivait dans le composant : le démonter
// — fermer le panneau, changer de mode, de session, de projet — le jetait, et
// il était le même pour toutes les sessions.
//
//     node scripts/check-composer.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-composer-check")
mkdirSync(dir, { recursive: true })
const out = path.join(dir, "h.cjs")
await build({
  stdin: { contents: `export * from "${path.join(ROOT, "src/renderer/state/composer").replace(/\\/g, "/")}"`, resolveDir: ROOT },
  outfile: out,
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
})

const stockage = new Map()
globalThis.localStorage = {
  getItem: (k) => (stockage.has(k) ? stockage.get(k) : null),
  setItem: (k, v) => stockage.set(k, String(v)),
}
const require = createRequire(import.meta.url)
const charger = () => {
  delete require.cache[out]
  return require(out)
}

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

let c = charger()
c.setDraftFor("session-a", "un brouillon pour A")
c.setDraftFor("session-b", "et un pour B")
check("**chaque session garde son brouillon**", c.draftFor("session-a") === "un brouillon pour A" && c.draftFor("session-b") === "et un pour B")
check("une session sans brouillon part vide", c.draftFor("session-c") === "")
c.flushDrafts()
c = charger()
check("**un brouillon survit à un rechargement**", c.draftFor("session-a") === "un brouillon pour A")
c.setDraftFor("session-a", "")
c.flushDrafts()
check("un brouillon vidé n'est plus gardé", !JSON.parse(stockage.get("zyvro.agentDrafts")).hasOwnProperty("session-a"))

c.rememberPrompt("premier")
c.rememberPrompt("deuxième")
c.rememberPrompt("deuxième")
c.rememberPrompt("  ")
check("**l'historique retient les prompts, sans doublon ni vide**", c.promptHistory().join("|") === "premier|deuxième", c.promptHistory().join("|"))
c.rememberPrompt("premier")
check("un prompt renvoyé remonte en tête", c.promptHistory().join("|") === "deuxième|premier")
check("et l'historique survit à un rechargement", charger().promptHistory().join("|") === "deuxième|premier")

c = charger()
check("**↑ rappelle le dernier prompt**", c.stepHistory("s", -1, "ce que j'écrivais") === "premier")
check("↑ encore, celui d'avant", c.stepHistory("s", -1, "premier") === "deuxième")
check("au bout, ↑ ne va nulle part", c.stepHistory("s", -1, "deuxième") === null)
check("↓ redescend", c.stepHistory("s", 1, "deuxième") === "premier")
check("**et au bout, ↓ rend ce qu'on écrivait avant de remonter**", c.stepHistory("s", 1, "premier") === "ce que j'écrivais")
check("↓ sans navigation ne fait rien", c.stepHistory("s", 1, "x") === null)
c.stepHistory("s", -1, "")
c.leaveHistory("s")
check("taper fait sortir de l'historique", !c.inHistory("s"))

// ---- la session neuve, après un redémarrage ----
// Elle n'a pas d'identifiant stable : son brouillon est aussi rangé par
// dossier, et la session neuve suivante du même dossier le reprend.
c = charger()
const blank = c.blankKey("/projets/demo")
c.setDraftFor("neuve-1", "écrit avant de quitter")
c.setDraftFor(blank, "écrit avant de quitter")
c.flushDrafts()
c = charger()
check("**la session neuve d'après le redémarrage reprend le brouillon**", c.draftShown("neuve-2", blank) === "écrit avant de quitter")
check("une session qui a des messages ne le prend pas", c.draftShown("ancienne", null) === "")
check("un autre dossier non plus", c.draftShown("neuve-3", c.blankKey("/ailleurs")) === "")
c.setDraftFor("neuve-2", "")
check("**dès qu'on y touche, la session ne montre plus que le sien**", c.draftShown("neuve-2", blank) === "")

// ---- une seule session vierge tient la clé du dossier ----
// Défaut de l'alpha.56, reproduit par une autre session : toutes les sessions
// vierges d'un dossier partageaient `blank:<dossier>` — une nouvelle montrait
// le brouillon d'une autre et, en le vidant, l'effaçait pour les deux.
c = charger()
const cle = c.blankKey("/projets/partage")
check("la première session vierge prend la clé", c.holdsBlank("v1", cle))
check("**une seconde ne la prend pas**", !c.holdsBlank("v2", cle))
c.setDraftFor("v1", "à moi")
c.setDraftFor(cle, "à moi")
check("**et ne montre pas le brouillon de la première**", c.draftShown("v2", cle) === "")
c.releaseBlank("v2", cle)
check("une session qui ne tient pas la clé ne peut pas la vider", c.draftFor(cle) === "à moi")
c.releaseBlank("v1", cle)
check("**la propriétaire qui envoie libère et vide la clé**", c.draftFor(cle) === "" && c.holdsBlank("v3", cle))
c.setDraftFor("garde", "gardé")
c.forgetDraft("garde")
check("**une session fermée emporte son brouillon**", c.draftFor("garde") === "")
c.stepHistory("nav", -1, "en cours")
check("**Échap pendant la navigation rend ce qu'on écrivait**", c.cancelHistory("nav") === "en cours" && !c.inHistory("nav"))

// La fenêtre se ferme dans les 250 ms qui suivent la dernière frappe.
const surDechargement = []
globalThis.window = { addEventListener: (type, fn) => type === "pagehide" && surDechargement.push(fn) }
c = charger()
c.setDraftFor("vite", "tapé juste avant de fermer")
check("la sauvegarde attend la fin de la rafale", !JSON.parse(stockage.get("zyvro.agentDrafts")).hasOwnProperty("vite"))
for (const fn of surDechargement) fn()
check(
  "**fermer la fenêtre aussitôt après avoir tapé garde les derniers mots**",
  surDechargement.length > 0 && JSON.parse(stockage.get("zyvro.agentDrafts")).vite === "tapé juste avant de fermer"
)
delete globalThis.window

const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
check(
  "**le panneau tient son brouillon hors du composant, par session**",
  /useSyncExternalStore\(subscribeDrafts, \(\) => draftShown\(thread\.id, blank\)/.test(panel) && !/const \[draft, setDraft\] = useState\(""\)/.test(panel)
)
check("et seule la session qui tient la clé du dossier y écrit", /if \(holdsBlank\(id, blank\)\) setDraftFor\(blank!, texte\)/.test(panel))
check("l'envoi la libère", /releaseBlank\(threadId, blank\)/.test(panel))
check(
  "**fermer une session vierge ne vide la clé que si elle la tenait**",
  /forgetDraft\(id\)/.test(panel) && /releaseBlank\(id, blankKey\(useWorkspace\.getState\(\)\.root\)\)/.test(panel)
)
check(
  "**la boîte reprend la hauteur de son brouillon quand elle réapparaît**",
  /const poserComposer = useCallback/.test(panel) && /ref=\{poserComposer\}/.test(panel) && /sessionVue\.current !== thread\.id/.test(panel)
)
check("Échap y annule la navigation", /event\.key === "Escape" && inHistory\(thread\.id\)/.test(panel))
check("chaque envoi rejoint l'historique", /rememberPrompt\(prompt\)/.test(panel))
check("↑ et ↓ y naviguent", /stepHistory\(thread\.id, event\.key === "ArrowUp" \? -1 : 1, draft\)/.test(panel))

console.log(failures === 0 ? "\nCe qu'on écrit reste, et ce qu'on a envoyé revient avec ↑." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
