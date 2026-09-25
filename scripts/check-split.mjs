// L'éditeur partagé en deux (⌘\) : le même document des deux côtés.
//
// Ce qui casse en silence ici :
//
// 1. **Deux éditeurs, deux modèles.** Le second détruisait le modèle du
//    premier en prenant son adresse : l'éditeur de gauche écrivait dans le
//    vide. Le modèle est partagé et compté.
// 2. **⌘S qui n'enregistre plus rien.** Fermer la vue de droite désinscrivait
//    l'enregistreur de l'onglet, et celui de gauche avec : « rien à faire ».
// 3. **Un onglet fantôme à droite.** Fermé à gauche, remplacé comme aperçu ou
//    renommé : la droite suit.
//
//     node scripts/check-split.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-split-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  [
    `export { useWorkspace, focusedTabId } from "${path.join(ROOT, "src/renderer/state/workspace").replace(/\\/g, "/")}"`,
    `export { registerSaver, saveTab } from "${path.join(ROOT, "src/renderer/state/savers").replace(/\\/g, "/")}"`,
    "",
  ].join("\n")
)
globalThis.localStorage = { getItem: () => null, setItem() {} }
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const { useWorkspace, focusedTabId } = t
const st = () => useWorkspace.getState()
useWorkspace.setState({
  project: { project: "/p", name: "p", daemon: {} },
  tabs: [
    { kind: "file", id: "file:a.ts", path: "a.ts", title: "a.ts" },
    { kind: "file", id: "file:b.ts", path: "b.ts", title: "b.ts", pinned: true },
    { kind: "settings", id: "settings", title: "Settings" },
  ],
  activeTabId: "file:a.ts",
  drafts: {},
  split: null,
  focusedGroup: "main",
})

st().splitEditor()
check("**⌘\\ montre le fichier actif à droite aussi**", st().split?.ids.join() === "file:a.ts" && st().split?.active === "file:a.ts")
check("et il reste à gauche", st().tabs.some((x) => x.id === "file:a.ts") && st().activeTabId === "file:a.ts")
check("**épinglé, pour ne pas être remplacé comme aperçu**", st().tabs.find((x) => x.id === "file:a.ts").pinned === true)
check("la droite prend la main", st().focusedGroup === "split" && focusedTabId() === "file:a.ts")

st().activateTab("settings")
st().splitEditor()
check("un onglet qui n'est pas un fichier ne se partage pas", st().split.ids.join() === "file:a.ts")

st().splitEditor("file:b.ts")
check("un onglet nommé (glissé) s'ajoute à droite", st().split.ids.join() === "file:a.ts,file:b.ts" && st().split.active === "file:b.ts")

st().focusGroup("main")
check("cliquer à gauche rend la main à gauche", focusedTabId() === "settings")

st().openFile("c.ts")
st().focusGroup("split")
st().activateTab("settings")
check("**un onglet activé à gauche y ramène la main**", st().focusedGroup === "main" && focusedTabId() === "settings")

st().movePath("b.ts", "lib/b.ts")
check("**renommé, il suit à droite**", st().split.ids.join() === "file:a.ts,file:lib/b.ts" && st().split.active === "file:lib/b.ts")

st().closeTab("file:a.ts")
check("**fermé à gauche, il part de droite**", st().split.ids.join() === "file:lib/b.ts")

// Le côté droit a la main : un fichier ouvert (arbre, ⌘P) s'y ouvre.
st().focusGroup("split")
const gaucheAvant = st().activeTabId
st().openFile("d.ts")
check("**avec la main à droite, un fichier s'ouvre à droite**", st().split.active === "file:d.ts" && st().split.ids.includes("file:d.ts"))
check("sans changer l'onglet regardé à gauche", st().activeTabId === gaucheAvant && st().focusedGroup === "split")
check("et épinglé, pour qu'un aperçu ne l'emporte pas", st().tabs.find((x) => x.id === "file:d.ts")?.pinned === true)
st().closeInSplit("file:d.ts")
st().focusGroup("main")

st().closeInSplit("file:lib/b.ts")
check("fermer la dernière vue de droite referme le groupe", st().split === null && st().focusedGroup === "main")
check("sans fermer l'onglet de gauche", st().tabs.some((x) => x.id === "file:lib/b.ts"))

// ---- deux éditeurs pour un onglet ------------------------------------------------
{
  const ecrits = []
  const gauche = t.registerSaver("file:x", async () => (ecrits.push("gauche"), true))
  const droite = t.registerSaver("file:x", async () => (ecrits.push("droite"), true))
  await t.saveTab("file:x")
  droite()
  await t.saveTab("file:x")
  check("**fermer la vue de droite laisse ⌘S à celle de gauche**", ecrits.join() === "droite,gauche", ecrits.join())
  gauche()
}

{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const monaco = lire("src/renderer/lib/monaco.ts")
  check("**le modèle est partagé et compté**", /if \(existant && n > 0\)/.test(monaco) && /tenus\.delete\(cle\)\s*\n\s*model\.dispose\(\)/.test(monaco))
  const editeur = lire("src/renderer/panels/CodeEditor.tsx")
  check("l'éditeur le lâche au lieu de le détruire", /releaseModel\(model\)/.test(editeur) && !/editor\.getModel\(\)\?\.dispose\(\)/.test(editeur))
  check("⌘F et Go to Line visent le côté qui a la main", /useWorkspace\.getState\(\)\.focusedGroup === group/.test(editeur))
  const pont = lire("src/renderer/lib/menuBridge.ts")
  check("⌘S enregistre l'onglet du côté qui a la main", /saveTab\(focusedTabId\(\)\)/.test(pont))
  const zone = lire("src/renderer/panels/EditorArea.tsx")
  check("un onglet de droite lâché à gauche y revient", /store\.closeInSplit\(id\)\s*\n\s*store\.activateTab\(id\)/.test(zone))
  check("⌘W à droite ne ferme que la vue", /s\.closeInSplit\(s\.split\.active\)/.test(pont))
  const menu = lire("src/main/index.ts")
  check(
    "le clic droit d'un onglet de droite ouvre son menu, sur les vues de droite",
    /onMenu=\{\(tabId, at\) => setMenu\(\{ tabId, at, group: "split" \}\)\}/.test(zone) && !/onMenu=\{\(\) => undefined\}/.test(zone)
  )
  check(
    "à droite, fermer ferme la vue, pas l'onglet (aucune question)",
    /if \(!aDroite\) return requestCloseTabs\(cibles\)[\s\S]*?store\.closeInSplit\(id\)/.test(zone)
  )
  check("à gauche, « Split Right »", /splitEditor\(tabId\)\)\}>\s*Split Right/.test(zone))
  check("View › Split Editor, ⌘\\", /label: "Split Editor",\s*accelerator: "CmdOrCtrl\+\\\\"/.test(menu))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nDeux côtés, un document : ce qu'on tape à gauche paraît à droite, et ⌘S l'écrit.")
