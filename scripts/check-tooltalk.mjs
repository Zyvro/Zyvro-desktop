// Ce que le panneau dit de ce que l'agent fait.
//
// Le flux porte tout — chaque `tool_use` avec son entrée, chaque `tool_result`
// avec sa sortie — et le panneau n'en gardait que le nom de l'outil. Quelqu'un
// qui le regardait écrire du code lisait « ran Edit ».
//
// La forme reprise est celle que VS Code et Cursor ont tous deux adoptée,
// relevée dans leur code livré : deux temps (`invocationMessage` pendant,
// `pastTenseMessage` après), une phrase qui nomme son sujet et jamais l'outil
// seul, et un détail propre à chaque genre d'outil.
//
// Ce script épingle les phrases, parce qu'une table de correspondance est
// exactement le genre de chose qui se dégrade sans que rien n'échoue.
//
//     node scripts/check-tooltalk.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-tooltalk-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/main/tooltalk").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { describeTool, planIn, outputIn } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

// Les entrées sont celles d'un vrai flux, relevées en faisant travailler
// l'agent sur un projet jetable.
const read = describeTool("Read", { file_path: "/long/chemin/vers/README.md" })
check("Read nomme le fichier, pas l'outil", read.done === "Read README.md", read.done)
check("et le dit au présent pendant qu'il tourne", read.running === "Reading README.md", read.running)
check("le chemin complet reste dans le détail", read.detail === "/long/chemin/vers/README.md")

const edit = describeTool("Edit", { file_path: "/a/b/math.js" })
check("Edit dit ce qu'il a édité", edit.done === "Edited math.js", edit.done)
check("Write se distingue d'Edit", describeTool("Write", { file_path: "/a/b/x.ts" }).done === "Wrote x.ts")

const bash = describeTool("Bash", { command: "ls -1 /tmp", description: "List files in working directory" })
check("Bash préfère la description du modèle à la commande", /List files/.test(bash.done), bash.done)
check("et garde la commande en détail", bash.detail === "ls -1 /tmp")
const bare = describeTool("Bash", { command: "grep -rn 'add' . | head -50" })
check("sans description, la commande fait la phrase", /grep -rn/.test(bare.done), bare.done)
check("une commande longue est coupée pour la ligne de résumé", describeTool("Bash", { command: "x".repeat(200) }).done.length < 70)

const grep = describeTool("Grep", { pattern: "add", path: "/projet/src" })
check("une recherche dit quoi et où", grep.done === "Searched for add in src", grep.done)
check("sans chemin, elle dit juste quoi", describeTool("Glob", { pattern: "**/*.ts" }).done === "Searched for **/*.ts")

// Relevé dans une vraie trace : BashOutput n'a pas de `command`, il porte un
// identifiant de shell. Replié sur Bash, il donnait « Running » suivi de rien.
const output = describeTool("BashOutput", { bash_id: "bash_1" })
check("BashOutput a sa propre phrase, pas une phrase vide", output.done === "Checked on a running command", output.done)
check("et ne finit pas par du vide", !/\s$/.test(output.done))
check("il reste de la famille terminal", output.shape === "terminal")

check("WebFetch nomme l'adresse", /example\.com/.test(describeTool("WebFetch", { url: "https://example.com/a" }).done))
check("TodoWrite parle du plan", describeTool("TodoWrite", {}).done === "Updated the plan")
check("Task dit ce qui est délégué", /revoir les tests/.test(describeTool("Task", { description: "revoir les tests" }).done))

// Les outils Zyvro arrivent par MCP sous un nom de plomberie.
const mcp = describeTool("mcp__zyvro__run_workflow", {})
check("un outil MCP ne montre pas sa plomberie", !/mcp__/.test(mcp.done), mcp.done)
check("il se lit en clair", mcp.done === "run workflow (zyvro)", mcp.done)
check("et porte sa propre forme", mcp.shape === "zyvro")

const unknown = describeTool("QuelqueChoseDeNouveau", {})
check("un outil inconnu ne casse rien", unknown.done === "Ran QuelqueChoseDeNouveau", unknown.done)
check("et retombe sur la forme générique", unknown.shape === "other")

// Les formes pilotent le rendu ; se tromper de forme donne le mauvais corps.
check("un terminal est un terminal", bash.shape === "terminal")
check("une lecture est une lecture", read.shape === "read")
check("une recherche est une recherche", grep.shape === "search")

// Le plan, seul champ d'entrée montré tel quel.
const plan = planIn({ todos: [{ content: "Lire le code", status: "completed" }, { content: "Écrire le test", status: "in_progress" }, { status: "pending" }] })
check("le plan garde ses entrées nommées", plan.length === 2, JSON.stringify(plan))
check("avec leur état", plan[0].status === "completed" && plan[1].status === "in_progress")
check("une entrée sans titre est écartée", !plan.some((p) => p.title === ""))
check("une entrée qui n'est pas une liste ne casse rien", planIn({ todos: "non" }).length === 0)

// La sortie : plate, et bornée avant de traverser l'IPC.
check("une sortie en texte passe telle quelle", outputIn("deux lignes\nici") === "deux lignes\nici")
check("une sortie en blocs est aplatie", outputIn([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "a\nb")
check("une sortie absente donne une chaîne vide", outputIn(undefined) === "")
const huge = outputIn("x".repeat(9000))
check("une sortie énorme est coupée avant l'IPC", huge.length < 4200, `${huge.length} caractères`)
check("et dit ce qui manque", /more characters/.test(huge))

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nLe panneau dit ce que l'agent fait, et le dit en français d'humain." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
