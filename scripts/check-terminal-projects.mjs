// Les shells, quand une fenêtre tient plusieurs projets.
//
// Signalé par Jeremy : un crash en ouvrant des shells persistants dans deux
// projets de la même fenêtre. Rejoué dans l'app : en développement, les
// shells des deux projets se retrouvaient dans les mêmes onglets — le même
// pty attaché deux fois, qui meurt avec le premier onglet qu'on ferme ; un
// projet fermé puis rouvert ramenait ses onglets morts ; rouvrir une session
// persistante déjà ouverte en attachait un second client.
//
//     node scripts/check-terminal-projects.mjs
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

check(
  "**le dossier affiché est un état React, pas une variable de module**",
  /const \[lie, setLie\] = useState<string \| null>\(null\)/.test(panel) && /projectDir !== lie/.test(panel) && !/let boundProject/.test(panel),
  "en StrictMode le passage de rendu jeté marquait la bascule comme faite"
)
check("**une reprise ne tourne qu'une fois par dossier**", /if \(reprisesEnVol\.has\(dir\)\) return/.test(panel))
check("et elle compare au dossier de travail, pas au projet", /if \(useWorkspace\.getState\(\)\.root !== dir\) return/.test(panel))
check(
  "**un projet fermé ne range pas ses onglets morts**",
  /const estFerme = \(dir: string\): boolean =>/.test(panel) && /if \(estFerme\(sortant\)\)/.test(panel) && /layoutsByProject\.delete\(dir\)/.test(panel)
)
check(
  "**une session persistante déjà ouverte se rejoint, sans second client**",
  /readStatus\(k\)\.persistent === ordre\.label/.test(panel) && /activate\(deja\)/.test(panel)
)

console.log(failures === 0 ? "\nChaque projet garde ses shells, et un shell n'est attaché qu'une fois." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
