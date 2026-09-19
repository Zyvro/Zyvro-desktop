// Les shells qui survivent à l'application.
//
// Un shell ordinaire est notre enfant : fermer la fenêtre le tue, avec tout son
// arbre — mesuré le 19/09, un `npm run dev` lancé dedans meurt avec elle. Pour
// qu'un programme continue quand Zyvro s'en va, il faut qu'il appartienne à
// quelqu'un d'autre : `tmux` ou `screen`.
//
// Ce qui casse en silence ici :
//
// 1. **Un nom qui n'est pas le nôtre.** Les sessions d'un gestionnaire sont
//    globales à la machine. Sans préfixe par projet, le panneau listerait — et
//    pire, tuerait — les sessions personnelles de quelqu'un.
//
// 2. **Un nom que le gestionnaire refuse.** `screen` coupe sur un point, c'est
//    son séparateur avec le pid. Une étiquette contenant un point donnerait une
//    session qu'on croit ouverte et qu'on ne retrouve jamais.
//
// 3. **Fermer au lieu de détacher.** C'est toute la fonction : si fermer
//    l'onglet tuait la session, elle ne servirait à rien. Éprouvé en vrai, pas
//    déduit.
//
// 4. **Une liste vide prise pour une panne.** `tmux list-sessions` sort en
//    erreur quand aucun serveur ne tourne, `screen -ls` aussi quand il n'y a
//    rien. Les deux veulent dire « aucune », pas « ça ne marche pas ».
//
//     node scripts/check-persistent.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-persistent-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {}, shell: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/main/persistent").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const PROJET = "/tmp/zyvro-projet-essai"
const AUTRE = "/tmp/zyvro-autre-projet"

// ---- les noms ------------------------------------------------------------
{
  const n = mod.nameFor(PROJET, "front dev")
  check("**un nom porte le préfixe de son projet**", n.startsWith("zyvro-") && n.endsWith("-front-dev"), n)
  check(
    "**et deux projets ne se mélangent pas**",
    mod.nameFor(PROJET, "x") !== mod.nameFor(AUTRE, "x"),
    "le panneau d'un projet listerait les sessions d'un autre"
  )
  // `screen` coupe sur un point : c'est son séparateur avec le pid. Une
  // étiquette qui en contient donnerait une session introuvable.
  check(
    "**un point ne survit pas dans un nom**",
    !mod.nameFor(PROJET, "v1.2 build").includes("."),
    "screen couperait le nom sur le point et on ne la retrouverait jamais"
  )
  check("ni un espace, ni un accent", mod.nameFor(PROJET, "Été chaud") === mod.nameFor(PROJET, "t chaud"))
  check("une étiquette vide reste ouvrable", mod.nameFor(PROJET, "   ").endsWith("-shell"))
  check("et l'étiquette se relit depuis le nom", mod.labelOf(PROJET, mod.nameFor(PROJET, "front dev")) === "front-dev")
}

// ---- la commande d'attachement -------------------------------------------
{
  const which = mod.manager()
  check(`un gestionnaire est trouvé ou non, sans planter (${which ?? "aucun"})`, which === null || which === "tmux" || which === "screen")

  if (which) {
    const cmd = mod.attachCommand(PROJET, "zyvro-x-front")
    check("**la commande attache ET crée**", cmd !== null && (cmd.args.includes("-A") || cmd.args.includes("-RR")), JSON.stringify(cmd))
    check("et elle nomme la session", cmd.args.includes("zyvro-x-front"))
  }
}

// ---- contre le vrai gestionnaire ------------------------------------------
//
// La partie qui compte. Tout le reste est du texte ; ceci est la propriété pour
// laquelle la fonction existe.
{
  const which = mod.manager()
  if (!which) {
    console.log("  --    ni tmux ni screen ici : l'épreuve en vrai est sautée")
  } else {
    const label = "essai-garde"
    const name = mod.nameFor(PROJET, label)
    mod.kill(name)

    // Créer détachée, comme le ferait un attachement dont on referme l'onglet.
    try {
      if (which === "tmux") execFileSync("tmux", ["new-session", "-d", "-s", name], { timeout: 5000 })
      else execFileSync("screen", ["-dmS", name, "/bin/sh", "-c", "sleep 60"], { timeout: 5000 })
    } catch (err) {
      console.log("  --    impossible de créer une session d'essai :", String(err.message).split("\n")[0])
    }

    const vues = mod.list(PROJET)
    check(
      "**une session de ce projet est listée**",
      vues.some((s) => s.name === name),
      `vu : ${JSON.stringify(vues.map((s) => s.name))}`
    )
    check("sous son étiquette, pas son nom interne", vues.some((s) => s.label === label))
    // Celle d'un autre projet ne doit pas y figurer.
    check(
      "**et elle n'apparaît pas dans un autre projet**",
      !mod.list(AUTRE).some((s) => s.name === name),
      "le panneau montrerait les sessions d'un projet voisin"
    )

    mod.kill(name)
    check(
      "**tuer la retire pour de bon**",
      !mod.list(PROJET).some((s) => s.name === name),
      "une session oubliée tournerait des semaines"
    )
    check("et tuer ce qui n'existe plus ne lève pas", (() => { mod.kill(name); return true })())
  }
}

// ---- la place dans l'interface -------------------------------------------
{
  const app = readFileSync(path.join(ROOT, "src/renderer/App.tsx"), "utf8")
  const entre = app.indexOf("<BrowserList />") < app.indexOf("<PersistentList />") &&
    app.indexOf("<PersistentList />") < app.indexOf("<WorkflowList />")
  check("**la section est entre Browsers et Workflows**", entre, "Jeremy a demandé cette place précisément")

  const liste = readFileSync(path.join(ROOT, "src/renderer/panels/PersistentList.tsx"), "utf8")
  check(
    "**et elle ne se dessine pas là où rien ne la tient**",
    liste.includes("if (!project || !dispo.data || mode === \"ai\") return null"),
    "une section vide sur Windows, à expliquer chaque jour"
  )
  // Tuer se demande : la session contient justement ce qu'on avait pris soin de
  // ne pas perdre.
  // En mode IA il n'y a pas de terminal — c'est la différence entre les deux
  // modes, pas un panneau fermé. Une section dont chaque ligne serait inerte y
  // serait pire qu'une section absente. Vu à l'écran avant d'être corrigé.
  check(
    "**ni là où il n'y a pas de terminal du tout**",
    liste.includes('mode === "ai"'),
    "les lignes s'affichent en mode IA et ne font rien quand on clique"
  )
  check("**tuer une session demande**", liste.includes("askConfirm("))
  check("et le panneau dit que fermer l'onglet ne tue pas", /only detache?s? it|détache/i.test(liste))

  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  check(
    "**un onglet de session porte son nom, pas « Shell 3 »**",
    panel.includes("readStatus(key).persistent ?? `Shell ${index + 1}`"),
    "on ne sait plus laquelle on regarde"
  )

  // Le rendu n'invente pas un nom réel : il envoie l'étiquette, le principal
  // fabrique le nom préfixé. Sinon une fenêtre pourrait attacher la session
  // personnelle de quelqu'un en devinant son nom.
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  check(
    "**le rendu ne choisit pas le nom réel d'une session**",
    ipc.includes("persistent.nameFor(root, String(label ?? \"\"))"),
    "une fenêtre attacherait n'importe quelle session de la machine"
  )
  check(
    "**et ne tue que ce qui appartient à ce projet**",
    ipc.includes("persistent.list(root).some((shell) => shell.name === name)"),
    "on tuerait la session personnelle de quelqu'un depuis ce panneau"
  )
}

// ---- les deux fonctions ne se marchent pas dessus -------------------------
//
// Signalé par Jeremy une heure après la première version : « quand je rouvre
// l'app alors que j'avais un shell persistant, celui-ci est ouvert et visible
// dans Persistent shells mais le process ne tourne plus ». Deux fonctions
// écrites coup sur coup — le tampon qui garde le défilement à la fermeture, et
// les sessions persistantes — et la première avalait la seconde : la session
// était sauvée comme un shell ordinaire, et la réouverture la recréait morte,
// avec son ancien défilement. Elle avait l'air ouverte, et rien ne tournait
// dedans.
{
  const term = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")

  check(
    "**une session persistante se sait telle**",
    /attached: command !== null/.test(term),
    "rien ne la distingue d'un shell ordinaire"
  )
  check(
    "**et son défilement n'est pas gardé à la fermeture**",
    /!session\.attached &&/.test(term),
    "la réouverture recrée un shell mort affichant l'historique d'une session vivante"
  )
  // Mais elle reste reprise après un rechargement du rendu : son client est
  // vivant, et l'oublier le ferait fuir comme n'importe quel shell.
  const liste = term.slice(term.indexOf("running(cwd: string)"))
  check(
    "**mais elle est reprise après un rechargement**",
    !/session\.cwd === lieu && !session\.attached/.test(liste.slice(0, 600)),
    "le client d'attachement fuirait, invisible, jusqu'à la fermeture"
  )
  check("et l'onglet repris garde son nom", term.includes("label: session.label"))

  // La course : la reprise demande au principal, ce qui prend un aller-retour,
  // et un `setSessions` sec effacerait l'onglet ouvert entre-temps par un clic
  // dans la barre latérale. Le clic paraît alors sans effet.
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  check(
    "**et la reprise n'écrase pas un onglet ouvert entre-temps**",
    panel.includes("setSessions((actuelles) => [...keys, ...actuelles.filter((key) => !keys.includes(key))])"),
    "cliquer une session pendant la reprise ne fait rien du tout"
  )
}

console.log(
  failures === 0
    ? "\nUne session persistante appartient à son projet, se détache quand on ferme, et ne meurt que si on le demande."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
