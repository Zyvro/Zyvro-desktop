// Ce qui marche quand aucun projet n'est ouvert.
//
// Demandé par Jeremy en trois phrases : « la liste des providers doit être
// accessible même si aucun projet ouvert », « les providers c'est global pas
// par projet », « les agents c'est par projet si projet ouvert sinon global »
// — puis « shells pareil » et « workflows aussi, on peut en avoir des
// globaux ».
//
// Ce qui l'empêchait tenait en une confusion : un moteur naissait avec un
// projet, donc « pas de projet » voulait dire « pas de moteur », donc pas de
// catalogue de fournisseurs (« Could not load the provider list »), pas
// d'agent, pas de shell. Deux questions différentes portaient le même nom.
//
// La réponse est un dossier d'accueil : sans projet, la fenêtre en ouvre un, et
// le reste du code continue de parler à un moteur comme d'habitude. Ce garde
// tient les trois propriétés qui le font tenir.
//
//     node scripts/check-home.mjs
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const engineMain = path.resolve(ROOT, "../Zyvro-engine/cmd/zyvrod/main.go")
const engineHome = path.resolve(ROOT, "../Zyvro-engine/localstore/machine.go")

const files = {
  daemon: path.join(ROOT, "src/main/daemon.ts"),
  ipc: path.join(ROOT, "src/main/ipc.ts"),
  project: path.join(ROOT, "src/renderer/lib/project.ts"),
  workspace: path.join(ROOT, "src/renderer/state/workspace.ts"),
  agent: path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"),
  terminal: path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"),
  shells: path.join(ROOT, "src/renderer/panels/PersistentList.tsx"),
  workflows: path.join(ROOT, "src/renderer/panels/WorkflowList.tsx"),
}

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const read = (k) => readFileSync(files[k], "utf8")

// ---- un seul endroit décide où Zyvro range ses affaires --------------------
{
  const daemon = read("daemon")
  check(
    "**le poste desktop demande le dossier d'accueil au moteur**",
    /execFileSync\(bin, \["--home"\]/.test(daemon),
    "un second chemin, c'est-à-dire celui qui a tort le jour où l'autre bouge"
  )
  if (existsSync(engineMain) && existsSync(engineHome)) {
    check(
      "**et le moteur sait répondre**",
      /flag\.Bool\("home"/.test(readFileSync(engineMain, "utf8")) &&
        /func HomeWorkspace\(\) \(string, error\)/.test(readFileSync(engineHome, "utf8")),
      "le drapeau a disparu du moteur et le poste desktop demande dans le vide"
    )
  } else {
    console.log("  --    le moteur n'est pas à côté de ce dépôt : sa moitié est sautée")
  }
}

// ---- une fenêtre a toujours un moteur -------------------------------------
{
  const ipc = read("ipc")
  check(
    "**une fenêtre sans projet ouvre quand même un moteur**",
    /async function ensureEngine\(ws: Workspace\): Promise<DaemonInfo>/.test(ipc) &&
      /const home = homeWorkspace\(\)/.test(ipc),
    "« pas de projet » redevient « pas de moteur »"
  )
  check(
    "**et « où ça travaille » n'est plus « ce qui est ouvert »**",
    /project: string \| null = null/.test(ipc) && /root: string \| null = null/.test(ipc),
    "les deux questions reprennent le même nom, et la confusion revient"
  )
  // requireRoot ne doit plus refuser faute de projet : il y a toujours un
  // dossier, celui d'accueil à défaut d'un autre.
  const gate = ipc.slice(ipc.indexOf("function requireRoot(ws: Workspace)"), ipc.indexOf("async function ensureEngine"))
  check(
    "et il ne refuse plus faute de projet",
    !/No project is open/.test(gate),
    "les shells et les agents refusent de partir sans dossier ouvert"
  )
  check(
    "**fermer un projet ramène le moteur à la maison, il ne l'éteint pas**",
    /const daemon = await ensureEngine\(ws\)\n    return \{ daemon \}/.test(ipc),
    "fermer un dossier vide le panneau des fournisseurs"
  )
}

// ---- et la fenêtre s'y branche --------------------------------------------
{
  const project = read("project")
  check(
    "**sans projet, le rendu branche le moteur de la maison**",
    /async function attachHome\(\): Promise<void>/.test(project) && /if \(!current\) await attachHome\(\)/.test(project),
    "l'adresse reste vide et le panneau des fournisseurs échoue"
  )
  check(
    "et fermer un projet ne débranche plus l'adresse",
    !/else detachDaemon\(\)/.test(project),
    "le panneau des fournisseurs devient inutilisable parce qu'on a fermé un dossier"
  )

  const workspace = read("workspace")
  check("**le rendu retient où ça travaille**", /  root: string \| null/.test(workspace) && /setRoot: \(root\) => set\(\{ root \}\)/.test(workspace))
}

// ---- ce qui s'en sert -----------------------------------------------------
{
  check(
    "**l'agent demande s'il y a un moteur, pas s'il y a un projet**",
    /const pret = useSyncExternalStore\(subscribeEngine, engineReady/.test(read("agent")),
    "le composeur dit « Open a project first » à un agent global"
  )
  for (const [quoi, clef] of [
    ["les shells", "terminal"],
    ["les shells persistants", "shells"],
    ["les workflows", "workflows"],
  ]) {
    check(
      `**${quoi} suivent la racine du moteur**`,
      /useWorkspace\(\((?:s|state)\) => (?:s|state)\.root\)/.test(read(clef)),
      "ils disparaissent dès qu'aucun projet n'est ouvert"
    )
  }
}

console.log(
  failures === 0
    ? "\nSans projet ouvert : un moteur, des fournisseurs, un agent, des shells et des workflows — ceux de la maison."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
