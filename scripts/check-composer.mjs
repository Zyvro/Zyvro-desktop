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

const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
check(
  "**le panneau tient son brouillon hors du composant, par session**",
  /useSyncExternalStore\(subscribeDrafts, \(\) => draftFor\(thread\.id\)/.test(panel) && !/const \[draft, setDraft\] = useState\(""\)/.test(panel)
)
check("chaque envoi rejoint l'historique", /rememberPrompt\(prompt\)/.test(panel))
check("↑ et ↓ y naviguent", /stepHistory\(thread\.id, event\.key === "ArrowUp" \? -1 : 1, draft\)/.test(panel))

console.log(failures === 0 ? "\nCe qu'on écrit reste, et ce qu'on a envoyé revient avec ↑." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
