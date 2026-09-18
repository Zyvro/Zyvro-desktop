// Une entrée réclamée par un motif est une entrée.
//
// Signalé par Jeremy sur un vrai workflow : le chemin de sortie était
// `abyssal-hd/{{input:gfx}}`, et le fichier créé s'appelait littéralement
// `{{input:gfx}}` — trois mégaoctets d'image, réécrits à chaque exécution,
// invisibles. Rien n'échouait : le run était vert, l'aperçu montrait l'image.
//
// Le défaut avait deux moitiés, et il fallait les deux :
//
// 1. **Le moteur laissait passer.** Un motif qui ne correspond à aucune entrée
//    restait dans la chaîne, et `fileOutput` s'en servait comme d'un nom. Il
//    échoue maintenant en nommant l'entrée manquante — c'est la seule partie du
//    message qui serve. (Éprouvé côté Go.)
//
// 2. **Rien ne le réclamait.** Les entrées d'un run n'étaient découvertes que
//    sur les nœuds `textInput`/`imageInput` portant un `inputKey`. Un
//    `{{input:gfx}}` écrit dans un chemin ne déclarait rien : le panneau ne
//    demandait pas `gfx`, donc le run partait sans, donc le motif restait. Les
//    deux moitiés se tenaient par la main.
//
// C'est la seconde que ce garde tient — et le fait que les deux côtés cherchent
// le même motif, puisque l'un prépare ce que l'autre exige.
//
//     node scripts/check-placeholders.mjs
import { build } from "esbuild"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const nodesTs = path.resolve(ROOT, "../Zyvro-frontend/src/lib/nodes.ts")
const runtimeGo = path.resolve(ROOT, "../Zyvro-engine/engine/runtime.go")
for (const [quoi, ou] of [["nodes.ts du front", nodesTs], ["runtime.go du moteur", runtimeGo]]) {
  if (!existsSync(ou)) {
    console.log(`ignoré : ${quoi} n'est pas à côté de ce dépôt (${ou})`)
    process.exit(0)
  }
}

const dir = path.join(ROOT, "node_modules", ".zyvro-placeholder-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { runtimeInputDefs } from "${nodesTs.replace(/\.ts$/, "").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node",
  absWorkingDir: ROOT, logLevel: "silent",
})
const { runtimeInputDefs } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const noeud = (id, type, config, label = "") => ({ id, type, data: { label, config } })

// ---- le cas réel ---------------------------------------------------------
{
  // Le workflow de Jeremy, réduit à ce qui compte : une source figée, une
  // sortie qui réclame `gfx`.
  const defs = runtimeInputDefs([
    noeud("f1", "fileInput", { path: "abyssal/53013.png", as: "image" }, "Sprite source"),
    noeud("o1", "fileOutput", { path: "abyssal-hd/{{input:gfx}}", createDirs: true }, "Ecrire abyssal-hd/"),
  ])
  check("**un motif dans un chemin de sortie réclame son entrée**", defs.some((d) => d.key === "gfx"), JSON.stringify(defs))
  // Sans valeur par défaut : c'est tout l'intérêt d'un motif, et le panneau
  // doit le demander plutôt que de partir sans.
  check("et sans valeur par défaut", defs.find((d) => d.key === "gfx")?.hasDefault === false)
  check("il porte le nom du nœud qui le réclame", defs.find((d) => d.key === "gfx")?.nodeId === "o1")
}

// ---- partout où le moteur substitue --------------------------------------
{
  const partout = runtimeInputDefs([
    noeud("a", "fileInput", { path: "abyssal/{{input:gfx}}" }),
    noeud("b", "textInput", { value: "redessine {{input:sujet}}" }),
    noeud("c", "monPack", { options: { taille: "{{input:taille}}", liste: ["{{input:teinte}}"] } }),
  ])
  const clefs = partout.map((d) => d.key).sort()
  check(
    "**un chemin d'entrée, un texte, la configuration d'un pack**",
    JSON.stringify(clefs) === '["gfx","sujet","taille","teinte"]',
    JSON.stringify(clefs)
  )
}

// ---- et rien d'inventé ---------------------------------------------------
{
  check("un graphe sans motif ne réclame rien", runtimeInputDefs([noeud("a", "fileOutput", { path: "out/fixe.png" })]).length === 0)
  check("des accolades qui ne sont pas un motif non plus", runtimeInputDefs([noeud("a", "textInput", { value: "{ceci} et {{cela}}" })]).length === 0)
  check("un motif vide non plus", runtimeInputDefs([noeud("a", "textInput", { value: "{{input:}}" })]).length === 0)

  // Un nœud d'entrée nommé `sujet` et un `{{input:sujet}}` ailleurs parlent de
  // la même valeur : la demander deux fois serait demander deux fois la même
  // chose.
  const memeNom = runtimeInputDefs([
    noeud("t", "textInput", { inputKey: "sujet", value: "un chat" }),
    noeud("o", "fileOutput", { path: "out/{{input:sujet}}.png" }),
  ])
  check("**un nom déjà déclaré n'est pas demandé deux fois**", memeNom.length === 1, JSON.stringify(memeNom))
  // Et c'est la déclaration du nœud d'entrée qui gagne : elle a un type et une
  // valeur par défaut, le motif n'a ni l'un ni l'autre.
  check("et c'est le nœud d'entrée qui la décrit", memeNom[0].hasDefault === true && memeNom[0].nodeId === "t")
}

// ---- les deux côtés cherchent le même motif ------------------------------
{
  // L'un prépare ce que l'autre exige : si le front cessait de reconnaître une
  // forme que le moteur reconnaît, le panneau ne demanderait pas une entrée
  // dont l'absence fait maintenant échouer le run.
  const go = readFileSync(runtimeGo, "utf8")
  const duMoteur = /inputPlaceholder = regexp\.MustCompile\(`([^`]+)`\)/.exec(go)?.[1] ?? ""
  const front = readFileSync(nodesTs, "utf8")
  const duFront = /const INPUT_PLACEHOLDER = \/([^/]+)\/g/.exec(front)?.[1] ?? ""
  // Les deux syntaxes échappent différemment ; on compare ce qu'elles matchent.
  const normaliser = (motif) => motif.replace(/\\\\/g, "\\")
  check(
    "**le moteur et la fenêtre cherchent le même motif**",
    duMoteur !== "" && normaliser(duMoteur) === normaliser(duFront),
    `moteur ${JSON.stringify(duMoteur)} · fenêtre ${JSON.stringify(duFront)}`
  )
  // Et le moteur refuse vraiment ce qui reste.
  check(
    "et le moteur refuse ce qu'il n'a pas pu résoudre",
    /this workflow needs an input named/.test(go),
    "un motif non résolu repasserait en silence"
  )
}

console.log(
  failures === 0
    ? "\nUne entrée réclamée par un motif est demandée avant le run, et refusée après."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
