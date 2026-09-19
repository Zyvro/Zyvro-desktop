// Une liste montre ce qui est, pas ce que nous avons fait.
//
// Deux listes de la barre latérale, un même défaut, signalé par Jeremy : « dès
// qu'on ouvre un shell persistant il doit apparaître dans la liste, et pareil
// s'il se ferme ; de même pour les graphes, quand on en crée un il doit
// directement être listé, et inversement en suppression ».
//
// Chacune se rafraîchissait sur nos propres gestes, et c'est précisément ce qui
// ne suffit pas :
//
// 1. **Les workflows.** Le bouton « + » du panneau invalidait bien sa requête,
//    mais un graphe créé ailleurs — par l'agent à travers MCP, par une autre
//    fenêtre, par un `git checkout` — n'apparaissait pas. Or un agent qui crée
//    un graphe est l'usage même de l'outil. La liste suit donc le dossier.
//
// 2. **Les shells persistants.** La liste attendait 1,2 s après un clic avant
//    de redemander, en espérant que `screen` ait fini — une supposition qui
//    tient tant que la machine n'est pas chargée. Et `screen -ls` ment
//    réellement pendant une seconde : la socket d'un client qu'on vient de
//    lancer n'existe pas encore quand la commande rend la main. Mesuré : la
//    session était attachée, `persistent.list()` la rendait, et la barre
//    affichait « aucune ».
//
//     node scripts/check-live-lists.mjs
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

const files = {
  workflows: path.join(ROOT, "src/renderer/panels/WorkflowList.tsx"),
  shells: path.join(ROOT, "src/renderer/panels/PersistentList.tsx"),
  terminal: path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"),
  state: path.join(ROOT, "src/renderer/state/persistent.ts"),
  ipc: path.join(ROOT, "src/main/ipc.ts"),
  manager: path.join(ROOT, "src/main/terminal.ts"),
}
for (const [quoi, ou] of Object.entries(files)) {
  if (!existsSync(ou)) {
    console.log(`  FAIL  ${quoi} introuvable (${ou})`)
    process.exit(1)
  }
}
const read = (k) => readFileSync(files[k], "utf8")
let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- les workflows suivent leur dossier -----------------------------------
{
  const s = read("workflows")
  // Dans le corps de la requête, et en début de ligne : la première version de
  // ce garde cherchait l'appel n'importe où dans le fichier, donc une ligne
  // commentée le satisfaisait — un garde qui ne peut pas échouer.
  const fn = s.slice(s.indexOf("queryFn: () => {"), s.indexOf("enabled: Boolean(project)"))
  check(
    "**la liste des workflows surveille le dossier où ils sont**",
    s.includes('const WORKFLOW_DIR = ".zyvro/workflows"') && /^\s*watchDir\(WORKFLOW_DIR\)$/m.test(fn),
    "un graphe créé par l'agent n'apparaît pas"
  )
  check(
    "**et un changement du dossier est une clé neuve**",
    /queryKey: \[\.\.\.workflowsKey, version\]/.test(s) && /versionOf\(WORKFLOW_DIR\)/.test(s),
    "le dossier est surveillé et personne n'écoute"
  )
  // Le préfixe reste, sinon les invalidations écrites ailleurs cessent de
  // porter — react-query compare par préfixe.
  check(
    "et les invalidations écrites ailleurs portent encore",
    /invalidateQueries\(\{ queryKey: workflowsKey \}\)/.test(s),
    "la clé a changé de forme sans garder son préfixe"
  )
  // Sans effet : la doctrine du dépôt, et la surveillance est idempotente.
  check("sans useEffect", !/useEffect/.test(s))
}

// ---- les shells persistants sont annoncés, pas devinés ---------------------
{
  const state = read("state")
  check(
    "**le rendu a un signal pour « une session vient de changer »**",
    /export function sessionsChanged\(\): void/.test(state) && /export function subscribeSessions\(/.test(state)
  )

  const term = read("terminal")
  check(
    "**celui qui attache prévient au moment où la session existe**",
    /sessionsChanged\(\)/.test(term.slice(term.indexOf("persistent\n          .open("), term.indexOf("persistent\n          .open(") + 700)),
    "la liste attend son prochain tour de sondage"
  )
  check(
    "**et il prévient aussi quand elle finit**",
    /if \(readStatus\(key\)\.persistent !== undefined\) sessionsChanged\(\)/.test(term),
    "une ligne morte reste à l'écran"
  )

  const list = read("shells")
  check(
    "**la liste écoute ce signal**",
    /useSyncExternalStore\(subscribeSessions, sessionsToken/.test(list) && /queryKey: \[\.\.\.KEY, token\]/.test(list)
  )
  // Le délai d'espoir, et il ne doit pas revenir : il tenait tant que la
  // machine n'était pas chargée.
  check(
    "**et plus personne n'attend 1,2 s en espérant**",
    !/setTimeout\([\s\S]{0,80}?1200\)/.test(list),
    "une supposition sur le temps qu'il faut à screen"
  )
  check(
    "le sondage reste, pour ce qui se passe hors de l'application",
    /refetchInterval: 10_000/.test(list),
    "un screen lancé dans un terminal à côté n'apparaîtrait jamais"
  )
}

// ---- et le principal ne demande pas à screen ce qu'il vient de faire -------
{
  const manager = read("manager")
  check(
    "**le gestionnaire de shells sait ce qu'il tient attaché**",
    /attachedLabels\(cwd: string\): string\[\]/.test(manager),
    "il faut croire screen sur parole, y compris quand il ment"
  )
  const ipc = read("ipc")
  const bloc = ipc.slice(ipc.indexOf('ipcMain.handle("persistent:list"'), ipc.indexOf('ipcMain.handle("persistent:open"'))
  check(
    "**et la liste ajoute ce que cette fenêtre vient d'attacher**",
    /ws\.terminals\.attachedLabels\(root\)/.test(bloc),
    "screen -ls ment pendant une seconde, et la session ouverte manque"
  )
  check(
    "sans doublon quand screen la connaît déjà",
    /connues\.has\(label\)/.test(bloc),
    "la même session apparaîtrait deux fois"
  )
}

console.log(
  failures === 0
    ? "\nUn graphe créé ailleurs apparaît, une session attachée aussi, et les deux s'en vont quand elles s'en vont."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
