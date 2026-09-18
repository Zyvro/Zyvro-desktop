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
  // Le dossier passe avec, depuis le 19/09 : c'est lui qui dit sous quel nom
  // garder le défilement pour la prochaine ouverture.
  check("tout fermer passe par le plan de travail", ipc.includes("this.terminals.disposeAll(this.root ?? undefined)"))

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

// ---- un rechargement n'abandonne plus les shells --------------------------
//
// Trouvé en creusant tmux avec Jeremy : les ptys sont des enfants du processus
// principal, donc une page qui recharge ne les tue pas — elle les oublie. Ils
// écrivaient dans le vide, injoignables jusqu'à la fermeture de la fenêtre,
// pendant que la page neuve en ouvrait un de plus à côté.
{
  const term = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")

  check(
    "**le principal sait dire quels shells vivent encore**",
    /running\(cwd: string\): \{ id: string; pty: boolean \}\[\]/.test(term),
    "une page rechargée n'a aucun moyen de les retrouver"
  )
  // Filtré par dossier : un pty a le cwd de sa naissance, et reprendre dans un
  // projet le shell d'un autre donnerait une invite qui ment.
  check("et seulement ceux de ce projet", /session\.cwd === lieu/.test(term))
  check(
    "**et il garde ce qu'ils ont écrit**",
    term.includes("SHELL_MAX_BYTES") && /session\.seen \+= data/.test(term),
    "se raccrocher rendrait une invite vivante sous un écran vide"
  )
  // Coupé de préférence à une fin de ligne : un flux de terminal est plein de
  // séquences d'échappement.
  check("borné, et coupé à une fin de ligne", /session\.seen\.indexOf\("\\n", trop\)/.test(term))

  check(
    "**le panneau adopte au lieu de créer**",
    panel.includes("const dejaLa = readStatus(key).ptyId") && panel.includes("reprise: true"),
    "un shell de plus s'ouvre à côté de celui qui tournait déjà"
  )
  // Lié d'abord, rejoué ensuite — la même règle que pour les tours d'agent.
  const rappel = panel.slice(panel.indexOf("const dejaLa = readStatus(key).ptyId"))
  check(
    "**et il lie avant de redemander le défilement**",
    rappel.indexOf("patchStatus(key, { ptyId: session.id") < rappel.indexOf("terminal.replay(session.id)"),
    "les données rejouées seraient mises de côté une seconde fois"
  )
}

// ---- et la fermeture laisse quelque chose derrière ------------------------
//
// Demandé par Jeremy : « on rouvre le projet, bam, on a toujours nos shells,
// avec nos programmes tués mais au moins une partie de l'historique ».
{
  const term = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")
  check(
    "**fermer la fenêtre garde le défilement**",
    /async disposeAll\(cwd\?: string\)/.test(term) && term.includes("await this.keepHistory(cwd, vivants)"),
    "tout est perdu à la fermeture, y compris ce qui aurait tenu"
  )
  // Écrit par un temporaire puis renommé : une fenêtre qui se ferme pendant
  // l'écriture laisserait sinon un JSON tronqué.
  check("écrit sans pouvoir être tronqué", term.includes("await fs.rename(temp, file)"))
  // Fermer un onglet à la main dit « je n'en veux plus » : ça ne doit pas
  // écrire d'historique.
  check(
    "**et fermer un seul shell n'en garde rien**",
    !/dispose\(id: string\): void \{[\s\S]{0,200}?keepHistory/.test(term),
    "fermer un onglet ressusciterait son défilement à la prochaine ouverture"
  )
  check(
    "**et le panneau le réaffiche, en disant que c'est du passé**",
    panel.includes("session précédente, les programmes ont été arrêtés"),
    "on relit une compilation d'hier en croyant qu'elle tourne"
  )

  // Le dossier suit le défilement. Signalé par Jeremy dix minutes après la
  // première version : rouvrir à la racine pendant que l'écran montre du
  // travail fait dans `server/` est un écran qui ment.
  check(
    "**et il rouvre dans le dossier où on était**",
    /cwd: this\.cwdOf\(session\.pty\.pid\) \?\? session\.cwd/.test(term),
    "l'invite s'ouvre à la racine sous un défilement qui parle d'ailleurs"
  )
  check("lu au système, pas deviné", term.includes("/usr/sbin/lsof") && term.includes("/proc/${pid}/cwd"))
  // Le rendu ne nomme pas un chemin : il renvoie une valeur que le principal
  // lui a donnée, et le principal la revérifie.
  check(
    "**et le rendu ne choisit pas où s'ouvre un shell**",
    ipc.includes("gardes.some((garde) => garde.cwd === cwd)"),
    "« ouvrir un shell ici » deviendrait « ouvrir un shell n'importe où »"
  )
  // Un fichier écrit par la première version ne portait que le texte.
  check(
    "et un historique d'avant ce champ se relit quand même",
    term.includes('if (typeof brut === "string")'),
    "une version de plus, et quelqu'un perd son historique"
  )
}

console.log(
  failures === 0
    ? "\nUn shell ne meurt que quand quelqu'un a le droit de le tuer."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
