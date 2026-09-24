// Les onglets : l'aperçu, l'épinglage, et leur ordre.
//
// Ce qui casse en silence ici :
//
// 1. **L'onglet sur lequel on vient de travailler disparaît.** Modifier un
//    fichier le garde ; mais une fois enregistré il redevenait propre, donc un
//    aperçu, et le fichier suivant ouvert depuis l'arbre le remplaçait. Modifier
//    épingle, pour de bon — comme dans VS Code.
//
// 2. **Double-cliquer ne garde rien.** L'épinglage explicite, pour garder un
//    fichier qu'on veut relire sans le modifier.
//
// 3. **L'ordre.** Déplacer un onglet sur lui-même ou à sa place ne doit rien
//    changer — ni l'ordre, ni la liste, que le magasin comparerait pour
//    réveiller tout le monde.
//
//     node scripts/check-tabs.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-tabs-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/renderer/state/workspace").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const { useWorkspace, reorder } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const ids = () => useWorkspace.getState().tabs.map((t) => t.id.replace("file:", "")).join(",")
const reset = () =>
  useWorkspace.setState({ project: { project: "/p", name: "p", daemon: {} }, tabs: [], activeTabId: "", drafts: {}, closedFiles: [] })

// ---- l'aperçu ----------------------------------------------------------------
{
  reset()
  const s = () => useWorkspace.getState()
  s().openFile("a.ts")
  s().openFile("b.ts")
  check("un fichier regardé est remplacé par le suivant", ids() === "b.ts", ids())

  s().setDraft("file:b.ts", "modifié")
  s().clearDraft("file:b.ts") // enregistré
  s().openFile("c.ts")
  check("**modifié puis enregistré, il reste : modifier épingle**", ids() === "b.ts,c.ts", ids())

  s().pinTab("file:c.ts")
  s().openFile("d.ts")
  check("**épinglé par double-clic, il reste aussi**", ids() === "b.ts,c.ts,d.ts", ids())
  s().openFile("e.ts")
  check("et l'aperçu suivant remplace toujours l'aperçu", ids() === "b.ts,c.ts,e.ts", ids())
}

// ---- l'ordre -----------------------------------------------------------------
{
  const t = ["a", "b", "c", "d"].map((id) => ({ id }))
  const ordre = (l) => l.map((x) => x.id).join("")
  check("avant un autre", ordre(reorder(t, "d", "b")) === "adbc")
  check("à la fin", ordre(reorder(t, "a", null)) === "bcda")
  check("vers la droite", ordre(reorder(t, "a", "c")) === "bacd")
  check("**sur lui-même : la même liste, pas une copie**", reorder(t, "b", "b") === t)
  check("**à sa propre place : la même liste aussi**", reorder(t, "b", "c") === t)
  check("un inconnu ne bouge rien", reorder(t, "z", "a") === t)

  reset()
  const s = useWorkspace.getState
  for (const f of ["a", "b", "c"]) {
    s().openFile(f)
    s().pinTab(`file:${f}`)
  }
  s().moveTab("file:c", "file:a")
  check("le magasin déplace l'onglet", ids() === "c,a,b", ids())
}

const zone = readFileSync(path.join(ROOT, "src/renderer/panels/EditorArea.tsx"), "utf8")
check("un aperçu s'écrit en italique", /apercu && "italic"/.test(zone))
check("double-cliquer un onglet l'épingle", /onDoubleClick=\{\(\) => useWorkspace\.getState\(\)\.pinTab\(tab\.id\)\}/.test(zone))
check("et glisser le déplace", /moveTab\(dragged, poseAvant\)/.test(zone))
const arbre = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
check("double-cliquer dans l'arbre épingle aussi", /pinTab\(`file:\$\{entry\.path\}`\)/.test(arbre))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUn onglet sur lequel on a travaillé reste, et les onglets se rangent à la main.")
