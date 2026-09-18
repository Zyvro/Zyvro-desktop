// Ce qui tue un shell, et ce qui n'a pas le droit de le tuer.
//
// Un terminal de ce panneau n'est pas un affichage : c'est un processus, et
// souvent trois — un serveur de développement, un CDN, un `debug.sh`. Les
// perdre, c'est perdre du travail en cours, et ça s'est produit.
//
// Signalé par Jeremy le 18/09 : kryone2.0 ouvert, trois shells lancés, et une
// trentaine de secondes plus tard les trois fermés ensemble. Trois shells ne
// meurent pas chacun de leur côté — quand ils partent ensemble, c'est que
// quelqu'un les a jetés d'un coup. Ce fichier tient la liste de ceux qui en ont
// le droit.
//
// Ce qui casse en silence ici :
//
// 1. **`null` pris pour « fermé ».** Le projet vaut `null` quand il n'y en a
//    pas, mais AUSSI quand la requête qui le porte cligne — une invalidation,
//    un rechargement du rendu, une réponse qui arrive vide une fraction de
//    seconde. Le panneau traitait les deux pareil, et jeter une session démonte
//    son composant, dont la fermeture tue le pty. Le prix d'une hésitation
//    d'affichage était trois programmes.
//
// 2. **Un quatrième chemin vers `disposeAll`.** Trois endroits ont le droit de
//    tout fermer : la fenêtre qui se ferme, l'application qui quitte, le projet
//    qu'on ferme. Un quatrième appel ajouté un jour, et des shells se mettent à
//    disparaître sans que personne ne relie la cause à l'effet.
//
//     node scripts/check-terminal-life.mjs
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
const index = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
const terminal = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")

// ---- un projet inconnu n'est pas un projet fermé -------------------------
{
  // La condition est le tout : sans le premier terme, une seconde de flottement
  // sur le projet coûte trois programmes.
  check(
    "**on ne jette les shells que pour un AUTRE projet**",
    panel.includes("if (projectDir !== null && projectDir !== boundProject) {"),
    "un projet momentanément inconnu ferait le même effet qu'un projet fermé"
  )

  // Et le `null` ne doit pas non plus être retenu : mémorisé, le retour du
  // chemin passerait pour un changement de projet et remplacerait les sessions
  // quand même — le défaut reviendrait par la porte de derrière.
  const bloc = panel.slice(panel.indexOf("if (projectDir !== null"), panel.indexOf("if (projectDir !== null") + 400)
  check(
    "**et un `null` ne s'enregistre pas comme projet courant**",
    !/setBoundProject\(null\)/.test(panel) && bloc.includes("setBoundProject(projectDir)"),
    "le retour du même projet serait pris pour un changement"
  )

  // Ce que la branche ne doit plus contenir : le vidage pur et simple.
  check(
    "**et plus personne ne vide la liste sur un projet absent**",
    !/if \(projectDir === null\) \{\s*setSessions\(\[\]\)/.test(panel),
    "la branche qui coûtait trois serveurs de développement est revenue"
  )
}

// ---- fermer une session tue bien son processus ---------------------------
//
// C'est le comportement voulu, et c'est ce qui rend le point précédent grave :
// oublier une session n'est pas l'oublier, c'est la tuer.
{
  check(
    "fermer une session tue son pty",
    panel.includes("void window.zyvro.terminal.dispose(ptyId)"),
    "un shell fermé continuerait de tourner sans fenêtre"
  )
  check("et le processus principal le tue vraiment", terminal.includes("this.drop(id)?.pty.kill()"))
}

// ---- qui a le droit de tout fermer d'un coup -----------------------------
{
  // `disposeAll` ne doit être appelé que par `dispose()` du plan de travail, et
  // ce plan de travail ne doit être jeté que par trois chemins.
  check("tout fermer passe par le plan de travail", ipc.includes("this.terminals.disposeAll()"))

  // Trois chemins, comptés là où ils sont écrits. `disposeWorkspace` est une
  // aide : son propre `ws.dispose()` n'est pas un quatrième appelant, et le
  // compter ferait échouer ce garde sans que rien n'ait changé — première
  // version, première fausse alerte.
  const parLaFenetre = [...index.matchAll(/disposeWorkspace\(win\)/g)].length
  const direct = [...ipc.matchAll(/ws\.dispose\(\)/g)].length
  check(
    "**et trois chemins seulement y mènent**",
    parLaFenetre === 2 && direct === 2,
    `${parLaFenetre} par la fenêtre (attendu 2 : fermeture et arrêt) et ${direct} dans ipc.ts ` +
      `(attendu 2 : « project:close » et le corps de disposeWorkspace) — un de plus est un chemin nouveau`
  )
  check("la fenêtre qui se ferme", index.includes('win.on("closed"'))
  check("l'application qui quitte", index.includes('app.on("before-quit"'))
  check("le projet qu'on ferme", ipc.includes('ipcMain.handle("project:close"'))

  // Ouvrir un projet ne ferme PAS les shells côté principal : c'est le rendu
  // qui décide, et il vient d'apprendre à ne le faire que pour un autre projet.
  const ouvre = ipc.slice(ipc.indexOf('ipcMain.handle("project:open"'), ipc.indexOf('ipcMain.handle("project:current"'))
  check(
    "**et ouvrir un projet ne ferme rien tout seul**",
    !ouvre.includes("disposeAll") && !ouvre.includes("ws.dispose()"),
    "rouvrir le même projet tuerait les shells en cours"
  )
}

console.log(
  failures === 0
    ? "\nUn shell ne meurt que quand quelqu'un a le droit de le tuer."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
