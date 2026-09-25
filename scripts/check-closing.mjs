// Enregistrer ce qu'on vise, et ne rien perdre en fermant.
//
// Ce qui cassait en silence :
//
// 1. **⌘S enregistrait tous les fichiers ouverts.** Chaque éditeur écoutait la
//    commande du menu, et tous restent montés, onglet caché compris. Un fichier
//    ouvert il y a une heure, changé depuis par un autre programme, était
//    réécrit avec la vieille version.
//
// 2. **La croix d'un onglet modifié jetait les modifications**, sans question.
//
// 3. **⌘W fermait la fenêtre.** Le rôle `close` de macOS, et `windowMenu` sous
//    Windows : le projet, les shells et l'agent partaient pour un geste qu'on
//    fait en pensant à un onglet.
//
// 4. **Un enregistrement raté fermait quand même.** Le disque plein, un fichier
//    en lecture seule : l'onglet partait avec ce qu'on venait de demander de
//    garder.
//
//     node scripts/check-closing.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-closing-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  [
    `export { requestCloseTab, requestCloseTabs, saveAll, tabsToClose } from "${rel("src/renderer/lib/closing")}"`,
    `export { registerSaver, saveTab } from "${rel("src/renderer/state/savers")}"`,
    `export { getPending, settle } from "${rel("src/renderer/state/prompt")}"`,
    `export { useWorkspace } from "${rel("src/renderer/state/workspace")}"`,
    "",
  ].join("\n")
)
// `closing` pose son écouteur de fermeture au chargement.
globalThis.window = { addEventListener: () => {}, close: () => {} }
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { "~": path.join(ROOT, "src/renderer") },
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
const tick = () => new Promise((r) => setTimeout(r, 0))
const fichier = (p) => ({ kind: "file", id: `file:${p}`, path: p, title: p.split("/").pop() })

function etat(tabs, drafts = {}) {
  t.useWorkspace.setState({
    project: { project: "/p", name: "p", daemon: {} },
    tabs: tabs.map(fichier),
    activeTabId: `file:${tabs[0]}`,
    drafts,
    closedFiles: [],
  })
}

// ---- enregistrer vise un onglet --------------------------------------------
{
  const ecrits = []
  const offA = t.registerSaver("file:a.ts", async () => (ecrits.push("a"), true))
  const offB = t.registerSaver("file:b.ts", async () => (ecrits.push("b"), true))
  await t.saveTab("file:a.ts")
  check("**enregistrer un onglet n'écrit que lui**", ecrits.join() === "a", ecrits.join())

  etat(["a.ts", "b.ts", "c.ts"], { "file:b.ts": "x" })
  ecrits.length = 0
  await t.saveAll()
  check("Save All écrit ce qui a un brouillon, et rien d'autre", ecrits.join() === "b", ecrits.join())
  offA()
  offB()
  check("un onglet sans éditeur inscrit n'est pas un échec", (await t.saveTab("file:inconnu")) === true)
}

// ---- fermer un onglet ------------------------------------------------------
{
  etat(["a.ts", "b.ts"])
  await t.requestCloseTab("file:a.ts")
  check("un onglet propre se ferme sans question", !t.useWorkspace.getState().tabs.some((x) => x.id === "file:a.ts"))
  check("et se retient pour ⌘⇧T", t.useWorkspace.getState().closedFiles.join() === "a.ts")
  t.useWorkspace.getState().reopenClosed()
  check("**⌘⇧T le rouvre**", t.useWorkspace.getState().activeTabId === "file:a.ts")

  etat(["a.ts", "b.ts"], { "file:a.ts": "modifié" })
  let ferme = t.requestCloseTab("file:a.ts")
  await tick()
  check("**un onglet modifié demande avant de fermer**", t.getPending()?.alternativeLabel === "Don't Save", JSON.stringify(t.getPending()))
  t.settle(null)
  check("Cancel ne ferme rien", (await ferme) === false && t.useWorkspace.getState().tabs.length === 2)

  ferme = t.requestCloseTab("file:a.ts")
  await tick()
  t.settle("alternative")
  check("Don't Save ferme et jette le brouillon", (await ferme) === true && !("file:a.ts" in t.useWorkspace.getState().drafts))

  etat(["a.ts", "b.ts"], { "file:a.ts": "modifié" })
  let enregistre = false
  const off = t.registerSaver("file:a.ts", async () => {
    enregistre = true
    t.useWorkspace.getState().clearDraft("file:a.ts")
    return true
  })
  ferme = t.requestCloseTab("file:a.ts")
  await tick()
  t.settle("yes")
  check("Save enregistre puis ferme", (await ferme) === true && enregistre)
  off()

  etat(["b.ts", "a.ts"], { "file:a.ts": "modifié" })
  const offEchec = t.registerSaver("file:a.ts", async () => false)
  ferme = t.requestCloseTab("file:a.ts")
  await tick()
  t.settle("yes")
  const resultat = await ferme
  const s = t.useWorkspace.getState()
  check("**un enregistrement raté ne ferme pas**", resultat === false && s.tabs.some((x) => x.id === "file:a.ts"))
  check("et montre l'onglet qui a échoué", s.activeTabId === "file:a.ts", s.activeTabId)
  check("le brouillon est toujours là", s.drafts["file:a.ts"] === "modifié")
  offEchec()
}

// ---- fermer plusieurs onglets -------------------------------------------------
{
  const ids = ["a", "b", "c", "d"]
  check("Close Others", t.tabsToClose(ids, "b", "others").join() === "a,c,d")
  check("**Close to the Right**", t.tabsToClose(ids, "b", "right").join() === "c,d")
  check("rien à droite du dernier", t.tabsToClose(ids, "d", "right").length === 0)
  check("Close All", t.tabsToClose(ids, "b", "all").join() === "a,b,c,d")

  etat(["a.ts", "b.ts", "c.ts"], { "file:b.ts": "x", "file:c.ts": "y" })
  let fini = t.requestCloseTabs(["file:a.ts", "file:b.ts", "file:c.ts"])
  await tick()
  const question = t.getPending()
  check("**une seule question pour tous les fichiers modifiés**", /2 files/.test(question?.title ?? ""), question?.title)
  t.settle(null)
  check("Cancel ne ferme rien, pas même les propres", (await fini) === false && t.useWorkspace.getState().tabs.length === 3)

  fini = t.requestCloseTabs(["file:a.ts", "file:b.ts", "file:c.ts"])
  await tick()
  t.settle("alternative")
  check("Don't Save ferme tout", (await fini) === true && t.useWorkspace.getState().tabs.length === 0)

  etat(["a.ts", "b.ts", "c.ts"], { "file:b.ts": "x", "file:c.ts": "y" })
  const offB = t.registerSaver("file:b.ts", async () => (t.useWorkspace.getState().clearDraft("file:b.ts"), true))
  const offC = t.registerSaver("file:c.ts", async () => false)
  fini = t.requestCloseTabs(["file:a.ts", "file:b.ts", "file:c.ts"])
  await tick()
  t.settle("yes")
  const ok = await fini
  const restants = t.useWorkspace.getState().tabs.map((x) => x.id).join()
  check("**Save All : ce qui a échoué reste ouvert, le reste se ferme**", ok === false && restants === "file:c.ts", restants)
  offB()
  offC()
}

// ---- le câblage ------------------------------------------------------------
{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const editeur = lire("src/renderer/panels/CodeEditor.tsx")
  check(
    "**aucun éditeur n'écoute la commande Save du menu**",
    !/onCommand\("save"/.test(editeur) && /registerSaver\(tabId, \(\) => save\(\)\)/.test(editeur)
  )
  const zone = lire("src/renderer/panels/EditorArea.tsx")
  check(
    "**revenu au texte enregistré, un fichier n'est plus modifié**",
    /if \(texte === enregistre\) clearDraft\(tabId\)/.test(editeur),
    "une frappe puis son effacement laissaient le point, et une question à la fermeture"
  )
  check("la croix d'un onglet demande", /requestCloseTab\(tab\.id\)/.test(zone))
  check("et le clic droit offre de fermer les autres", /fermer\(tabsToClose\(ids, tabId, "others"\)\)/.test(zone) && /if \(!aDroite\) return requestCloseTabs\(cibles\)/.test(zone))
  const menu = lire("src/main/index.ts")
  check("**⌘W est Close Editor**", /label: "Close Editor",\s*accelerator: "CmdOrCtrl\+W"/.test(menu))
  check("et le rôle `windowMenu`, qui le reprenait sous Windows, n'est plus là", !/role: "windowMenu"/.test(menu))
  check("aucun raccourci n'est un accord qu'Electron ne sait pas lire", !/accelerator: "[^"]* CmdOrCtrl/.test(menu))
  check("la fenêtre demande avant de partir", /addEventListener\("beforeunload"/.test(lire("src/renderer/lib/closing.ts")))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nOn enregistre ce qu'on vise, et on ne ferme rien sans demander.")
