// Fermer sans perdre : un graphe en cours d'enregistrement, et un projet qu'on
// quitte avec des modifications.
//
// Ce qui casse en silence ici :
//
// 1. **Le graphe fermé dans la seconde.** L'éditeur de graphe enregistre 1,2 s
//    après la dernière modification ; fermer son onglet avant démontait
//    l'éditeur et annulait l'enregistrement. On attend son badge « Saved ».
// 2. **Le badge renommé.** On le lit dans le composant partagé avec le site :
//    s'il change ses mots, l'attente ne verrait plus rien. Ce script lit le
//    composant et échoue le jour où ça arrive.
// 3. **Le projet quitté avec des brouillons.** Close Folder et Open Folder
//    fermaient tous les onglets sans rien demander.
//
//     node scripts/check-graph-close.mjs
import { build } from "esbuild"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-graph-close-check")
mkdirSync(dir, { recursive: true })
// Le module ne sert ici que pour sa fonction pure ; ses voisins sont doublés.
writeFileSync(path.join(dir, "vide.js"), "module.exports = { useWorkspace: {}, askConfirm: async () => false }\n")
await build({
  entryPoints: [path.join(ROOT, "src/renderer/lib/graphSave.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { "~/state/workspace": path.join(dir, "vide.js"), "~/state/prompt": path.join(dir, "vide.js") },
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

check("le badge se lit", t.saveStateOf("Saved") === "saved" && t.saveStateOf(" Saving ") === "saving" && t.saveStateOf("Unsaved") === "unsaved")
check("autre chose n'est pas un badge", t.saveStateOf("Save") === null && t.saveStateOf(null) === null && t.saveStateOf("Saved!") === null)

const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
{
  const builder = path.join(ROOT, "..", "Zyvro-frontend", "src", "components", "Builder.tsx")
  if (existsSync(builder)) {
    const b = readFileSync(builder, "utf8")
    check(
      "**l'éditeur de graphe écrit toujours Saved / Saving / Unsaved**",
      /saveState === "saved" \? "Saved" : saveState === "saving" \? "Saving" : "Unsaved"/.test(b)
    )
  } else {
    console.log("  skip  Zyvro-frontend absent à côté : le badge n'est pas relu")
  }
  const onglet = lire("src/renderer/panels/GraphTab.tsx")
  check("l'onglet du graphe se laisse trouver", /data-graph=\{workflowId\}/.test(onglet))
  const closing = lire("src/renderer/lib/closing.ts")
  check("**fermer un onglet attend son graphe**", /if \(!\(await graphsReadyToClose\(\[tabId\]\)\)\) return false/.test(closing))
  check("fermer plusieurs onglets aussi", /if \(!\(await graphsReadyToClose\(tabIds\)\)\) return false/.test(closing))
  check("**et la fenêtre**", /const graphes = unsavedGraphTabs\(\)/.test(closing) && /fermerApresLesGraphes/.test(closing))
  const projet = lire("src/renderer/lib/project.ts")
  check(
    "**changer de projet pose la question des brouillons**",
    /if \(store\.project && store\.project\.project !== target && !\(await lacherLesOnglets\(\)\)\) return null/.test(projet) &&
      /export async function closeProject\(\): Promise<void> \{\s*if \(!\(await lacherLesOnglets\(\)\)\) return/.test(projet)
  )
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUn graphe part enregistré, un projet ne part pas avec ses brouillons.")
