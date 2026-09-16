// Lire les workflows d'un projet qui n'est pas celui qu'on a ouvert.
//
// Un workflow est un fichier JSON sous `.zyvro/workflows/`. Ce qui rend la
// lecture délicate n'est pas le format mais ce qu'on trouve à côté : un fichier
// à moitié écrit, un JSON valide qui n'est pas un workflow, un dossier qui
// n'est pas un projet du tout. Un import qui refuse les quatre workflows lisibles
// parce que le cinquième est abîmé serait un import qui ne sert à rien.
//
//     node scripts/check-importing.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-import-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "electron.js"), "module.exports = { dialog: {} }\n")
writeFileSync(path.join(dir, "h.ts"), `export { read } from "${path.join(ROOT, "src/main/importing").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT, logLevel: "silent",
})
const { read } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const project = mkdtempSync(path.join(os.tmpdir(), "zyvro-source-"))
const wf = path.join(project, ".zyvro", "workflows")
mkdirSync(wf, { recursive: true })

const write = (file, value) => writeFileSync(path.join(wf, file), typeof value === "string" ? value : JSON.stringify(value), "utf8")

write("a.json", {
  id: "w1",
  name: "Photos produit",
  description: "Retaille et détoure",
  graph_json: JSON.stringify({ nodes: [{ id: "n1" }, { id: "n2" }], edges: [] }),
})
write("b.json", { id: "w2", name: "Résumé", graph_json: JSON.stringify({ nodes: [], edges: [] }) })
// Ce qu'on trouve vraiment à côté, et qui ne doit pas tout faire échouer.
write("c.json", "{ ceci n'est pas du JSON")
write("d.json", { id: "w4", name: "Sans graphe" })
write("notes.txt", "pas un workflow")
write("e.json", { id: "w5", name: "Graphe illisible", graph_json: "{pas du json}" })

const found = await read(project)
check("le projet est nommé par son dossier", found.name === path.basename(project))
check("les workflows lisibles sont là", found.workflows.map((w) => w.name).includes("Photos produit"))
check("un JSON cassé n'empêche pas les autres", found.workflows.length === 3, found.workflows.map((w) => w.name).join(", "))
check("un fichier sans graphe est écarté", !found.workflows.some((w) => w.name === "Sans graphe"))
check("un .txt est ignoré", !found.workflows.some((w) => w.name.includes("notes")))

const first = found.workflows.find((w) => w.name === "Photos produit")
check("la description est reprise", first.description === "Retaille et détoure")
check("les nœuds sont comptés", first.nodes === 2, String(first.nodes))
check("le graphe est rendu tel quel", JSON.parse(first.graphJSON).nodes.length === 2)
const broken = found.workflows.find((w) => w.name === "Graphe illisible")
check("un graphe illisible compte zéro nœud plutôt que de tout arrêter", broken.nodes === 0)

// Un dossier qui n'est pas un projet : « rien trouvé » et « ce n'est pas un
// projet » sont deux nouvelles différentes, et une seule veut dire qu'on s'est
// trompé de dossier.
const plain = mkdtempSync(path.join(os.tmpdir(), "zyvro-plain-"))
let refused = ""
try { await read(plain) } catch (error) { refused = error.message }
check("un dossier ordinaire le dit clairement", /is not a Zyvro project/.test(refused), refused)
check("et nomme le dossier en question", refused.includes(path.basename(plain)))

// Un projet sans workflows n'est pas une erreur.
const empty = mkdtempSync(path.join(os.tmpdir(), "zyvro-empty-"))
mkdirSync(path.join(empty, ".zyvro", "workflows"), { recursive: true })
const nothing = await read(empty)
check("un projet sans workflows répond une liste vide", nothing.workflows.length === 0)

rmSync(project, { recursive: true, force: true })
rmSync(plain, { recursive: true, force: true })
rmSync(empty, { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nUn projet voisin se lit sans qu'un fichier abîmé arrête tout." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
