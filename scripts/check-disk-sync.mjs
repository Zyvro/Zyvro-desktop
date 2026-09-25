// Un fichier ouvert qui change sur le disque — un agent, git, un autre
// programme.
//
// Ce qui casse en silence ici :
//
// 1. **⌘S qui écrase le travail de l'agent.** L'onglet gardait l'ancien texte,
//    et l'enregistrer effaçait ce que l'agent venait d'écrire. On relit le
//    disque avant d'écrire, et on demande s'il a bougé.
// 2. **Un onglet en retard.** Rien de modifié ici : l'onglet prend le texte du
//    disque tout seul.
// 3. **Un dossier replié qui rend l'éditeur sourd.** La surveillance est
//    comptée : l'arbre qui cesse de regarder un dossier ne la coupe pas à un
//    éditeur qui en dépend.
//
//     node scripts/check-disk-sync.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-disk-sync-check")
mkdirSync(dir, { recursive: true })
await build({
  entryPoints: [path.join(ROOT, "src/shared/diskSync.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
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

check("nos propres enregistrements ne font rien", t.onDiskChange("a", "a", "a") === "ignore" && t.onDiskChange("a", "a", "a+moi") === "ignore")
check("**rien de modifié ici : on reprend le disque**", t.onDiskChange("a", "a+agent", "a") === "reload")
check("la même chose des deux côtés : rien à demander", t.onDiskChange("a", "b", "b") === "adopt")
check("**des deux côtés : conflit, on ne touche à rien**", t.onDiskChange("a", "a+agent", "a+moi") === "conflict")
check("enregistrer sur le disque qu'on a lu : on écrit", t.beforeSave("a", "a", "a+moi") === "write")
check("**le disque a bougé depuis : on demande**", t.beforeSave("a", "a+agent", "a+moi") === "ask")
check("il a bougé vers notre texte : on écrit", t.beforeSave("a", "b", "b") === "write")
check("il n'existe plus : on le recrée", t.beforeSave("a", null, "a+moi") === "write")

{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const editeur = lire("src/renderer/panels/CodeEditor.tsx")
  check("**l'enregistrement relit le disque et demande**", /beforeSave\(base, disque, text\) === "ask"/.test(editeur) && /confirmLabel: "Overwrite"/.test(editeur))
  check("la sauvegarde automatique n'écrase jamais", /if \(auto\) return false/.test(editeur))
  check("l'éditeur surveille le dossier de son fichier", /watchDir\(dossier\)/.test(editeur) && /unwatchDir\(dossier\)/.test(editeur))
  check("le rechargement est une édition défaisable", /executeEdits\("zyvro-disk"/.test(editeur))
  check("un onglet rouvert relit le fichier", /gcTime: 0/.test(editeur))
  const watch = lire("src/renderer/state/fileWatch.ts")
  check("**la surveillance est comptée**", /if \(n > 0\) return/.test(watch) && /if \(n > 1\) \{/.test(watch))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nCe qu'un agent écrit apparaît dans l'onglet, et ⌘S ne l'efface pas sans demander.")
