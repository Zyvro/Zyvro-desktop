// L'auto-synthèse du chat : réécrire une demande avant de l'envoyer.
//
// Ce qui casse en silence ici :
//
// 1. **Une réécriture qui invente.** Chaque mode rappelle la règle : rien
//    d'ajouté, rien de retiré, le code et les chemins tels quels.
// 2. **Une réponse emballée** (clôture de code, guillemets, journal de codex)
//    envoyée à l'agent comme si c'était la demande.
// 3. **Réécrire deux fois.** Une demande relue revient dans la boîte ; Entrée
//    doit l'envoyer telle quelle.
//
//     node scripts/check-synthesize.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-synthesize-check")
mkdirSync(dir, { recursive: true })
await build({ entryPoints: [path.join(ROOT, "src/shared/synthesize.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const modes = t.SYNTHESIS_MODES.map((m) => m.value)
check("les modes : off, anglais, amélioré, les deux, tâche structurée", JSON.stringify(modes) === JSON.stringify(["off", "english", "improve", "both", "task"]))
for (const m of modes.filter((x) => x !== "off")) {
  const p = t.synthesisPrompt(m, "ajoute un bouton `Save` dans src/App.tsx")
  check(`**${m} : rien d'inventé, le code et les chemins tels quels**`, /Never invent requirements/.test(p) && /Keep code, file paths/.test(p) && p.endsWith("ajoute un bouton `Save` dans src/App.tsx"))
}
check("anglais : traduire, sans rien ajouter", /Translate the user's request/.test(t.synthesisPrompt("english", "x")))
check("améliorer garde la langue d'origine", /in the same language as the request/.test(t.synthesisPrompt("improve", "x")))
check("tâche : Goal, Context, Requirements, Done when", /Goal, Context, Requirements \(a bulleted list\), Done when/.test(t.synthesisPrompt("task", "x")))

check("**la clôture de code retirée**", t.cleanSynthesis("```\nAdd a Save button.\n```") === "Add a Save button.")
check("les guillemets aussi", t.cleanSynthesis('"Add a Save button."') === "Add a Save button.")
check("le journal de codex aussi", t.cleanSynthesis("[2026-09-25T10:00:00] thinking\ncodex\nAdd a Save button.") === "Add a Save button.")
check("un code dans la demande reste", t.cleanSynthesis("Fix this:\n```ts\nconst a = 1\n```") === "Fix this:\n```ts\nconst a = 1\n```")
check("un mode inconnu n'en est pas un", !t.isSynthesisMode("magic") && t.isSynthesisMode("both"))

{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const panel = lire("src/renderer/panels/AgentPanel.tsx")
  check("**une demande relue part telle quelle**", /text === reecriture\.sortie/.test(panel))
  check("Entrée et le bouton passent par la synthèse", /void envoyer\(draft\)\s*\n\s*\}/.test(panel) && /onClick=\{\(\) => void envoyer\(draft\)\}/.test(panel))
  const ipc = lire("src/main/ipc.ts")
  check("le principal refuse un mode inconnu et un texte démesuré", /!isSynthesisMode\(mode\) \|\| mode === "off"/.test(ipc) && /demande\.length > 40_000/.test(ipc))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLa demande gagne en clarté, et rien n'y est inventé.")
