// Ce que l'application fait quand son moteur meurt sans prévenir.
//
// Le démon `zyvrod` est un processus enfant, un par projet. Il peut mourir :
// planter, être tué, manquer de mémoire. Il en existe des rapports de plantage
// sur cette machine.
//
// Ce qui casse en silence ici :
//
// 1. **Une adresse qui ne répond plus, présentée comme vivante.** Le port et le
//    jeton du démon sont retenus au démarrage et distribués ensuite : au
//    panneau, aux outils MCP d'un agent, à la visée d'un harnais. Si personne ne
//    remarque la mort, tout continue de recevoir une adresse morte — et chacun
//    échoue à sa manière, loin de la cause.
//
// 2. **L'agent en paie le prix le plus cher.** Un tour est lancé avec une
//    configuration MCP qui pointe sur un port fermé. L'agent ne dit pas « le
//    moteur est arrêté » : il dit qu'il n'a pas pu lister les workflows, ou
//    rien du tout, et on cherche ailleurs.
//
//     node scripts/check-engine-death.mjs
import { build } from "esbuild"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-engine-death")
mkdirSync(dir, { recursive: true })

// `app` d'electron n'est lu que pour trouver le binaire livré ; ici on impose
// le nôtre par `ZYVROD_PATH`, donc un objet vide suffit.
writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: { isPackaged: false, getAppPath: () => "${dir}" } }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { Daemon } from "${path.join(ROOT, "src/main/daemon").replace(/\\/g, "/")}"\n`
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
const { Daemon } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Un faux moteur : il fait la poignée de main comme le vrai, puis meurt. C'est
// exactement ce qu'on n'a aucun moyen de provoquer à la main sur le vrai.
const faux = path.join(dir, "zyvrod")
writeFileSync(
  faux,
  `#!/usr/bin/env node
const vivre = Number(process.env.FAUX_VIE_MS || "0")
process.stdout.write(JSON.stringify({
  ready: true, port: 65500, token: "jeton-d-essai",
  project: process.argv[process.argv.indexOf("--project") + 1], version: "essai",
}) + "\\n")
if (vivre > 0) setTimeout(() => process.exit(7), vivre)
else setInterval(() => {}, 1000)
`
)
chmodSync(faux, 0o755)
process.env.ZYVROD_PATH = faux

const attendre = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- il démarre, et il est là --------------------------------------------
{
  process.env.FAUX_VIE_MS = "0"
  const d = new Daemon()
  const info = await d.start("/tmp")
  check("**le moteur démarre et se présente**", info.port === 65500 && info.token === "jeton-d-essai", JSON.stringify(info))
  check("et l'application le tient pour vivant", d.current !== null)
  await d.stop()
  check("**arrêté à la demande, il n'est plus là**", d.current === null)
}

// ---- il meurt tout seul --------------------------------------------------
//
// Le cœur du fichier. Avant correction, `current` continuait de rendre le port
// et le jeton d'un processus mort : l'application annonçait un moteur qui
// n'existait plus, et tout ce qui s'en sert échouait ailleurs.
{
  process.env.FAUX_VIE_MS = "250"
  const d = new Daemon()
  await d.start("/tmp")
  check("il est vivant juste après la poignée de main", d.current !== null)

  await attendre(900)
  check(
    "**mort sans prévenir, il n'est plus annoncé comme vivant**",
    d.current === null,
    "l'application distribue encore le port et le jeton d'un processus mort"
  )
  check("et sa version ne traîne pas non plus", d.engineVersion === "")
  await d.stop()
}

// ---- et on peut le savoir ------------------------------------------------
//
// Effacer l'adresse évite de mentir, mais ne dit rien à personne. Une fenêtre
// qui affiche « moteur local sur le port 50829 » doit pouvoir cesser de le dire.
{
  process.env.FAUX_VIE_MS = "250"
  const d = new Daemon()
  let annonce = null
  d.onStopped((raison) => {
    annonce = raison
  })
  await d.start("/tmp")
  await attendre(900)
  check("**et la mort est annoncée**", annonce !== null, "personne n'apprend que le moteur est parti")
  check("avec le code de sortie, qui est la moitié du diagnostic", String(annonce?.code) === "7", JSON.stringify(annonce))
  await d.stop()
}

// ---- un arrêt demandé n'est pas une mort ---------------------------------
//
// `stop()` est ce qu'on appelle en fermant un projet ou en quittant : prévenir
// la fenêtre d'une panne à ce moment-là ferait clignoter une alerte à chaque
// fermeture.
{
  process.env.FAUX_VIE_MS = "0"
  const d = new Daemon()
  let annonce = null
  d.onStopped(() => {
    annonce = "prévenu"
  })
  await d.start("/tmp")
  await d.stop()
  await attendre(200)
  check("**fermer soi-même ne déclenche pas l'alerte**", annonce === null, "une alerte à chaque fermeture de projet")
}

// ---- et quelqu'un écoute vraiment ---------------------------------------
//
// Une annonce que personne ne reçoit ne vaut pas mieux que pas d'annonce. C'est
// la faute exacte trouvée la veille sur le reçu de jetons de codex : la
// fonction existait, rien ne l'appelait, et le carnet la croyait branchée.
{
  const { readFileSync } = await import("node:fs")
  const lire = (rel) => readFileSync(path.join(ROOT, rel), "utf8")

  check(
    "**le processus principal prévient la fenêtre**",
    /ws\.daemon\.onStopped\(/.test(lire("src/main/ipc.ts")) && lire("src/main/ipc.ts").includes('send("engine:stopped"'),
    "la mort est remarquée et personne n'en est informé"
  )
  check("le pont la fait traverser", lire("src/preload/index.ts").includes('on("engine:stopped"'))
  check("le rendu l'écoute", lire("src/renderer/lib/menuBridge.ts").includes("window.zyvro.engine.onStopped("))
  check(
    "**et la barre d'état cesse d'annoncer un port mort**",
    lire("src/renderer/panels/StatusBar.tsx").includes("Local engine stopped"),
    "le chiffre faux reste à l'écran"
  )
  // Et l'annonce s'efface quand un projet rouvre : sinon la fenêtre garde le
  // souvenir d'une panne réparée.
  check("et l'annonce s'efface quand un moteur répond de nouveau", lire("src/renderer/lib/project.ts").includes("engineStarted()"))
}

console.log(
  failures === 0
    ? "\nUn moteur mort est un moteur mort, et l'application le sait."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
