// Le panneau Problems, et ce qui le rend utilisable.
//
// Ce qui casse en silence ici :
//
// 1. **Des modèles sans nom.** Monaco créait ses modèles à `inmemory://model/3`
//    : pas de fichier à nommer dans la liste, et un `.tsx` lu sans JSX — chaque
//    balise devenait une erreur.
//
// 2. **Le bruit.** L'éditeur voit un fichier à la fois, sans `node_modules` :
//    chaque `import` d'un paquet devenait « Cannot find module », et les vraies
//    erreurs se noyaient dedans.
//
// 3. **Go to Symbol et Go to Line** doivent viser l'éditeur visible, comme ⌘F,
//    pas tous les éditeurs montés.
//
//     node scripts/check-problems.mjs
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const monaco = lire("src/renderer/lib/monaco.ts")
check("**chaque modèle porte l'adresse de son fichier**", /scheme: "file", path: `\/\$\{path\}`/.test(monaco))
const editeur = lire("src/renderer/panels/CodeEditor.tsx")
check("l'éditeur prend son modèle à cette adresse, partagé", /acquireModel\(path, draft \?\? loaded\)/.test(editeur) && /monaco\.editor\.createModel\(text, languageFor\(path\), uri\)/.test(monaco))
check("et l'indentation se règle sur le modèle", /model\.detectIndentation\(/.test(editeur))
check("**« Cannot find module » est tu, les vraies erreurs restent**", /2307, \/\/ Cannot find module/.test(monaco) && !/2304/.test(monaco))
check("le JSX est compris dans un .tsx", /jsx: monaco\.languages\.typescript\.JsxEmit\.ReactJSX/.test(monaco))
const pb = lire("src/renderer/state/problems.ts")
check("les problèmes suivent les marqueurs", /monaco\.editor\.onDidChangeMarkers\(recalculer\)/.test(pb))
check("les erreurs d'abord", /RANG\[a\.severity\] - RANG\[b\.severity\]/.test(pb))
check("**le plan et la ligne visent l'éditeur visible**", /onCommand\("go-to-symbol", \(\) => \{\s*if \(!visible\(\)\) return/.test(editeur))
const fil = lire("src/renderer/panels/Breadcrumbs.tsx")
check("le fil d'Ariane surmonte l'éditeur", /<Breadcrumbs path=\{path\} \/>/.test(editeur))
check("un dossier du fil ouvre ⌘P filtré sur lui", /openQuickOpen\(`\$\{dossier\}\/`\)/.test(fil))
check("**la sauvegarde automatique ne formate jamais**", /if \(!auto && getSettings\(\)\.formatOnSave\) await formatDocument\(editor\)/.test(editeur) && /if \(modifie\(\)\) void save\(true\)/.test(editeur))
check("un langage sans formateur : rien, pas d'erreur", /if \(!action\?\.isSupported\(\)\) return/.test(monaco))
const menu = lire("src/main/index.ts")
check("⇧⌥F formate", /accelerator: "Shift\+Alt\+F"/.test(menu) && /"menu:format-document"/.test(menu))
check("⇧⌘O, ⌃G et ⇧⌘M dans les menus", /"CmdOrCtrl\+Shift\+O"/.test(menu) && /"Ctrl\+G"/.test(menu) && /"CmdOrCtrl\+Shift\+M"/.test(menu))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLes vraies erreurs des fichiers ouverts, à un clic de leur ligne.")
