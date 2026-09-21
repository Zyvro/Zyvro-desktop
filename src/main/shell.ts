import { app } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { locate } from "./cli"

// Quel shell le panneau ouvre.
//
// Il ouvrait `$SHELL`, ce qui est le shell de connexion du compte — ce que
// `chsh` a écrit, et ce que launchd donne à une application lancée depuis le
// Finder. C'est une réponse honnête et ce n'est pas toujours la bonne : un
// émulateur de terminal peut être réglé pour en lancer un autre (iTerm a un
// champ « Custom Shell », VS Code a terminal.integrated.defaultProfile), et
// alors le shell qu'on a tous les jours n'est pas celui que le compte déclare.
//
// Signalé exactement comme ça : « j'ouvre un shell, c'est pas le même shell que
// mon shell habituel ». `chsh` disait bash, iTerm lançait zsh, et toute la
// configuration — brew, nvm — était dans ~/.zshrc.
//
// Rien ne permet de deviner ça depuis l'application, donc on ne devine pas : on
// garde `$SHELL` par défaut et on laisse choisir. Le choix décrit la personne
// et sa machine, pas le projet ouvert, donc il vit à côté de la liste des
// projets récents plutôt que dans un dossier `.zyvro/`.

const isWindows = process.platform === "win32"

export type Shell = {
  /** Le fichier qu'on lancera. C'est aussi l'identité de l'entrée. */
  file: string
  /** `zsh`, `bash` — ce qu'on affiche. */
  name: string
  /** Celui que le compte déclare, c'est-à-dire le défaut. */
  account: boolean
  /** Celui qui sera lancé au prochain shell ouvert. */
  current: boolean
}

// Les shells qu'on propose, quand ils ne sont pas déjà nommés ailleurs.
//
// `/etc/shells` est la liste du système, et c'est la source : c'est elle que
// `chsh` accepte. Elle est incomplète chez ceux qui ont installé un shell sans
// l'y déclarer — un `fish` de Homebrew, par exemple — donc on demande aussi au
// PATH, qui est réparé avant que quoi que ce soit ne démarre (voir cli.ts). Ces
// noms-là ne résolvent rien : ils remplissent un menu que quelqu'un lit.
const KNOWN = ["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish"]

function storeFile(): string {
  return path.join(app.getPath("userData"), "shell.json")
}

// accountShell : ce que le compte déclare. `SHELL` d'abord parce que c'est ce
// que la session a réellement reçu ; le fichier de comptes ensuite, parce qu'il
// répond quand l'environnement ne dit rien.
export function accountShell(): string {
  if (isWindows) return process.env.COMSPEC || "cmd.exe"
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL
  try {
    const record = os.userInfo().shell
    if (record && fs.existsSync(record)) return record
  } catch {
    // Pas de fiche à lire. Le défaut ci-dessous reste vrai partout.
  }
  return "/bin/zsh"
}

// available : ce que cette machine peut ouvrir.
//
// Le shell du compte en tête, puisque c'est le défaut et que c'est celui qu'on
// cherche en ouvrant le menu.
export function available(): string[] {
  const out: string[] = []
  const add = (file: string | undefined | null) => {
    if (!file || out.includes(file) || !fs.existsSync(file)) return
    out.push(file)
  }

  add(accountShell())

  if (isWindows) {
    add(process.env.COMSPEC)
    for (const name of ["powershell", "pwsh"]) add(locate(name)?.file)
    return out
  }

  try {
    // Les commentaires en tête du fichier, et les lignes vides.
    for (const ligne of fs.readFileSync("/etc/shells", "utf8").split("\n")) {
      const entree = ligne.trim()
      if (entree && !entree.startsWith("#")) add(entree)
    }
  } catch {
    // Pas de /etc/shells lisible : le PATH répond encore en dessous.
  }

  for (const name of KNOWN) add(locate(name)?.file)
  return out
}

// chosen : le fichier retenu, ou null quand personne n'a choisi.
//
// Relu à chaque fois plutôt que gardé en mémoire : c'est un fichier minuscule,
// et le relire évite qu'une fenêtre ouverte hier lance un shell que la personne
// a changé depuis dans une autre.
export function chosen(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8")) as { file?: unknown }
    const file = typeof parsed.file === "string" ? parsed.file : null
    // Un shell désinstallé depuis — une mise à jour de Homebrew suffit — ne
    // doit pas donner un panneau qui ne s'ouvre plus. On retombe alors sur le
    // shell du compte, sans rien dire et sans effacer le choix : le paquet
    // peut revenir.
    return file && fs.existsSync(file) ? file : null
  } catch {
    return null
  }
}

// choose retient un shell, ou rend le défaut avec `null`.
//
// Le fichier est vérifié contre `available()` et pas seulement contre le
// disque. C'est la même règle que partout ici : ce qui vient de la fenêtre est
// du texte jusqu'à preuve du contraire, et « choisis mon shell » deviendrait
// sinon « lance n'importe quel exécutable de la machine ».
export function choose(file: string | null): string | null {
  if (file !== null && !available().includes(file)) {
    throw new Error(`"${file}" is not a shell this machine offers.`)
  }
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true })
    if (file === null) fs.rmSync(storeFile(), { force: true })
    else fs.writeFileSync(storeFile(), JSON.stringify({ file }, null, 2), "utf8")
  } catch {
    // Un choix qu'on n'a pas pu écrire vaut pour cette session : le shell
    // suivant le relit, et c'est tout ce qu'on perd.
  }
  return chosen()
}

// shells : la liste telle que le menu la lit.
export function shells(): Shell[] {
  const compte = accountShell()
  const courant = chosen() ?? compte
  return available().map((file) => ({
    file,
    name: path.basename(file, isWindows ? path.extname(file) : ""),
    account: file === compte,
    current: file === courant,
  }))
}

// command : ce que le pty lance.
//
// `-l` parce qu'un shell de connexion est ce qui lit les profils — nvm, pyenv,
// homebrew — et que le panneau doit ressembler au terminal de la personne.
// L'environnement du processus est déjà réparé avant (cli.ts) ; ceci est la
// seconde moitié de la même promesse.
export function command(): { file: string; args: string[] } {
  if (isWindows) return { file: chosen() ?? accountShell(), args: [] }
  return { file: chosen() ?? accountShell(), args: ["-l"] }
}
