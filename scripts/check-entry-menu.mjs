// Le clic droit sur un fichier ou un dossier.
//
// Ce qui casse en silence ici :
//
// 1. **Deux menus l'un sur l'autre.** L'application ouvre déjà un menu natif au
//    clic droit — celui qui porte « Copier ». Vérifié plutôt que supposé : un
//    `preventDefault` sur l'événement du rendu empêche Electron d'émettre le
//    sien, donc le menu de l'arbre doit le faire, sans quoi les deux
//    apparaissent.
//
// 2. **Supprimer pour de bon.** « Delete » dans un arbre de fichiers veut dire
//    ce qu'il veut dire dans le Finder : on peut revenir. Un `fs.rm` récursif
//    sur un clic mal visé, c'est du travail perdu qu'aucune confirmation ne
//    rattrape vraiment — on confirme ce qu'on croit avoir visé.
//
// 3. **Un chemin cité de deux façons.** Le dépôt d'un fichier cite déjà les
//    chemins pour le shell ; un menu qui recite à sa manière est la deuxième
//    citation qui se trompe le jour où un dossier a un espace. Éprouvé à
//    l'écran sur un dossier nommé « mes notes ».
//
// 4. **Un texte remis deux fois.** Deux panneaux lisent la même boîte, ou un
//    panneau relit après un rendu, et le chemin s'écrit deux fois dans la
//    question.
//
//     node scripts/check-entry-menu.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-menu-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/renderer/state/handoff").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { handTo, takeHandoff, tokenOf } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const menu = readFileSync(path.join(ROOT, "src/renderer/panels/EntryMenu.tsx"), "utf8")
const explorer = readFileSync(path.join(ROOT, "src/renderer/panels/Explorer.tsx"), "utf8")
const files = readFileSync(path.join(ROOT, "src/main/files.ts"), "utf8")

// ---- il s'ouvre là où on a cliqué, et seul -------------------------------
{
  check("**l'arbre ouvre un menu au clic droit**", explorer.includes("onMenu(entry, { x: event.clientX, y: event.clientY })"))
  check(
    "**et empêche celui d'Electron de s'ouvrir par-dessus**",
    /event\.preventDefault\(\)/.test(explorer),
    "deux menus se superposent au clic droit"
  )
  // Un menu contextuel s'ouvre sous le curseur, pas sous un bouton.
  check("il s'ouvre sous le curseur", menu.includes("style={{ left: at.x, top: at.y }}"))
  // Un seul pour tout l'arbre : il y en avait un par ligne, et sur un dossier
  // de vingt-huit mille fichiers c'étaient vingt-huit mille menus dans le DOM.
  check(
    "**et il n'y en a qu'un pour tout l'arbre**",
    explorer.split("<EntryMenu").length === 2 && /const \[menu, setMenu\]/.test(explorer),
    "un menu par ligne : le DOM enfle avec le dossier"
  )
}

// ---- ce qu'il propose est ce que l'application sait faire -----------------
{
  for (const entree of ["New file…", "New folder…", "Open", "Add to agent", "Open in terminal", "Reveal in Finder", "Copy path", "Copy relative path", "Rename…"]) {
    check(`il propose « ${entree} »`, menu.includes(entree))
  }
  // Et pas ce qui n'existe pas ici : un menu qui propose « Open to the Side »
  // sans éditeurs côte à côte est un menu dont la moitié déçoit.
  //
  // Cherché dans ce que le menu AFFICHE, pas dans le fichier : le commentaire
  // du haut nomme justement ces entrées pour dire pourquoi elles n'y sont pas,
  // et la première version de ce garde échouait sur sa propre explication.
  const rendu = menu.slice(menu.indexOf("<Menu.Portal>")).replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  for (const absent of ["Open to the Side", "Select for Compare", "Open Timeline", "Find File References"]) {
    check(`**il ne promet pas « ${absent} »**`, !rendu.includes(absent))
  }
}

// ---- supprimer va à la corbeille, et demande ------------------------------
{
  check(
    "**supprimer met à la corbeille, il n'efface pas**",
    files.includes("shell.trashItem(target)") && !/fs\.rm\(target/.test(files),
    "un clic mal visé efface un dossier pour de bon"
  )
  check("et la racine du projet reste intouchable", files.includes('Refused to delete the project root.'))
  check("**et il demande avant**", menu.includes("askConfirm("))
  // La question nomme le chemin entier : c'est la seule façon de voir qu'on
  // s'est trompé de ligne.
  check(
    "en nommant le chemin entier",
    menu.includes("${entry.path} moves to the trash."),
    "la question ne dit pas ce qu'elle va supprimer"
  )
}

// ---- un chemin cité une seule fois ---------------------------------------
{
  // `quotePath` est celle du dépôt : deux citations, c'est une des deux qui se
  // trompe le jour où un dossier a un espace.
  check(
    "**le `cd` cite par la fonction partagée**",
    menu.includes("quotePath(") && menu.includes('from "../../shared/dropped"'),
    "le menu cite les chemins dans son coin"
  )
  // Ce qui sort de l'arbre est absolu : l'agent et le shell ne savent pas d'où
  // l'arbre compte ses chemins.
  check("et ce qui sort est absolu", menu.includes("root.replace(/\\/$/, \"\")"))
  check("sauf « copier le chemin relatif », qui est relatif", menu.includes("copier(entry.path)"))
}

// ---- un texte remis est pris une fois ------------------------------------
{
  const avant = tokenOf("agent")
  handTo("agent", "/projet/fichier.txt")
  check("**remettre prévient**", tokenOf("agent") > avant)
  check("et le texte arrive", takeHandoff("agent") === "/projet/fichier.txt")
  // Pris, pas lu : un deuxième rendu ne doit pas le réécrire dans la question.
  check("**pris une fois, plus rien après**", takeHandoff("agent") === null)

  // Deux fois le même texte doit tout de même réveiller : un jeton, pas le
  // texte lui-même, sinon la deuxième remise passe inaperçue.
  handTo("agent", "/projet/a.txt")
  const premier = tokenOf("agent")
  takeHandoff("agent")
  handTo("agent", "/projet/a.txt")
  check("**deux fois le même chemin réveille deux fois**", tokenOf("agent") > premier)
  takeHandoff("agent")

  // Et les deux cibles ne se mélangent pas.
  handTo("terminal", "cd /projet\n")
  check("**le terminal et l'agent ont chacun leur boîte**", takeHandoff("agent") === null && takeHandoff("terminal") === "cd /projet\n")
  check("un texte vide ne remet rien", (handTo("agent", ""), takeHandoff("agent")) === null)

  // Et c'est bien par là que les deux panneaux écoutent.
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const terminal = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  check("l'agent écoute sa boîte", panel.includes('takeHandoff("agent")'))
  check("le terminal la sienne", terminal.includes('takeHandoff("terminal")'))
  // Sans shell vivant il n'y a nulle part où écrire.
  check(
    "**et le terminal n'écrit que s'il a un shell**",
    terminal.includes("if (ligne && ptyId)"),
    "on écrit dans le vide quand aucun shell ne tourne"
  )
}

console.log(
  failures === 0
    ? "\nLe clic droit propose ce que l'application sait faire, et supprimer veut dire « à la corbeille »."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
