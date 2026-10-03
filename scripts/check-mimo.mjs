// MiMo Code dans le panneau d'agent, lu sur ce que le binaire imprime.
//
// Les lignes ci-dessous sont copiées de `mimo run --format json`, version
// 0.1.15. Ce qui casse en silence : une session jamais retenue (l'agent
// redevient amnésique), un outil affiché sous son nom brut, une dépense qui ne
// compte que la dernière étape, un serveur MCP qui n'arrive pas — ou son jeton
// qui arrive sur la ligne de commande.
//
//     node scripts/check-mimo.mjs
import { build } from "esbuild"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-mimo-check")
mkdirSync(dir, { recursive: true })
await build({
  stdin: {
    contents: `export { sessionIn, mimoUsageIn, addSpent, mimoToolName, mimoModelsFrom, mimoConfig, argsFor } from "${path.join(ROOT, "src/main/agent").replace(/\\/g, "/")}"`,
    resolveDir: ROOT,
  },
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  logLevel: "silent",
})
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const tool = JSON.parse(
  `{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"call_b7","state":{"status":"completed","input":{"command":"echo hi","description":"Runs echo hi in shell"},"output":"hi\\n"}}}`
)
const etape1 = JSON.parse(
  `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","tokens":{"total":25679,"input":71,"output":50,"reasoning":22,"cache":{"write":0,"read":25536}},"cost":0.0001016008}}`
)
const etape2 = JSON.parse(
  `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","tokens":{"total":25781,"input":168,"output":3,"reasoning":10,"cache":{"write":0,"read":25600}},"cost":0.00009884}}`
)

check("**la session se lit sur `sessionID`**", mod.sessionIn(tool) === "ses_1")
check("**un outil prend le nom que le panneau sait raconter**", mod.mimoToolName(tool.part.tool) === "Bash")
check("un outil inconnu garde le sien", mod.mimoToolName("skill") === "skill")

const un = mod.mimoUsageIn(etape1)
check("**l'entrée compte le cache, la sortie le raisonnement**", un.input === 71 + 25536 && un.output === 50 + 22 && un.cacheRead === 25536, JSON.stringify(un))
const deux = mod.addSpent(un, mod.mimoUsageIn(etape2))
check(
  "**un tour en deux étapes coûte les deux**",
  deux.input === 71 + 25536 + 168 + 25600 && Math.abs(deux.costUsd - (0.0001016008 + 0.00009884)) < 1e-12,
  JSON.stringify(deux)
)

const liste = mod.mimoModelsFrom(
  "mimo/mimo-auto — window 1M, compacts at 900K\nxiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K\n\x1b[2mxiaomi/mimo-v2.6-flash\x1b[0m — window 1.05M\n"
)
check("**les modèles se lisent dans `mimo models`**", liste.join(",") === "mimo/mimo-auto,xiaomi/mimo-v2.6-pro,xiaomi/mimo-v2.6-flash", liste.join(","))

const config = mod.mimoConfig({ daemonOrigin: "http://127.0.0.1:4100", daemonToken: "jeton-secret" })
const lu = JSON.parse(config)
const zyvro = Object.values(lu.mcp)[0]
check(
  "**les serveurs MCP du projet arrivent au format d'opencode**",
  zyvro.type === "remote" && zyvro.url === "http://127.0.0.1:4100/mcp" && zyvro.headers.Authorization === "Bearer jeton-secret" && zyvro.enabled === true,
  config
)
check("sans démon, rien à déclarer", mod.mimoConfig({}) === null)
const ligne = mod.argsFor("mimo", { projectDir: "/p", workflows: [], permission: "project", daemonOrigin: "http://127.0.0.1:4100", daemonToken: "jeton-secret" }, null, null).join(" ")
check("**et le jeton n'est jamais sur la ligne de commande**", !ligne.includes("jeton-secret"), ligne)

console.log(failures === 0 ? "\nMiMo Code se lit comme il parle, et ses outils arrivent par son environnement." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
