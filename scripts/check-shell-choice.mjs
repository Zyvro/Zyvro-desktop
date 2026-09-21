// Le shell que le panneau ouvre.
//
// Il ouvrait `$SHELL` et rien d'autre. `$SHELL` est le shell de connexion du
// compte — ce que `chsh` a écrit, ce que launchd donne à une application lancée
// depuis le Finder — et ce n'est pas toujours celui qu'on a tous les jours : un
// émulateur de terminal peut être réglé pour en lancer un autre. Signalé
// exactement ainsi : « j'ouvre un shell, c'est pas le même shell que mon shell
// habituel » — `chsh` disait bash, iTerm lançait zsh.
//
// Ce script vérifie les trois choses que le choix doit tenir : il propose ce
// que la machine a, il refuse tout le reste, et il retombe sur le défaut quand
// ce qu'on avait choisi disparaît.
//
//     node scripts/check-shell-choice.mjs
import { build } from "esbuild"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-shell-check")
mkdirSync(dir, { recursive: true })

// La préférence vit dans `app.getPath("userData")`. Ici elle vit dans un
// dossier jetable : le test écrit un vrai fichier — c'est la moitié de ce qu'on
// vérifie — mais pas dans les données de l'application de quelqu'un.
const userData = mkdtempSync(path.join(os.tmpdir(), "zyvro-shell-"))
writeFileSync(
  path.join(dir, "electron.cjs"),
  `exports.app = { getPath: () => ${JSON.stringify(userData)} }\n`
)
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/main/shell").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node",
  alias: { electron: path.join(dir, "electron.cjs") },
  absWorkingDir: ROOT, logLevel: "silent",
})
const { accountShell, available, choose, chosen, command, shells } = createRequire(import.meta.url)(
  path.join(dir, "h.cjs")
)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const windows = process.platform === "win32"
const offered = available()

// ---- ce qu'on propose --------------------------------------------------
check("la machine offre au moins un shell", offered.length > 0)
check("et chacun existe vraiment", offered.every((file) => existsSync(file)), offered.join(", "))
check("le shell du compte est proposé", offered.includes(accountShell()), `compte : ${accountShell()}`)
check("le shell du compte est le premier", offered[0] === accountShell(), offered[0])
check("aucun doublon", new Set(offered).size === offered.length)

// ---- le défaut ---------------------------------------------------------
choose(null)
check("sans choix, rien n'est retenu", chosen() === null)
check("et c'est le shell du compte qui s'ouvre", command().file === accountShell())
check(
  windows ? "sans drapeau de connexion sous Windows" : "en shell de connexion",
  windows ? command().args.length === 0 : command().args.includes("-l")
)
check("le menu marque le shell du compte", shells().find((shell) => shell.account)?.file === accountShell())
check("et marque le courant", shells().filter((shell) => shell.current).length === 1)

// ---- un autre que le défaut --------------------------------------------
const autre = offered.find((file) => file !== accountShell())
if (!autre) {
  console.log("  (cette machine n'offre qu'un shell, rien à choisir)")
} else {
  choose(autre)
  check("un shell choisi est retenu", chosen() === autre)
  check("et c'est lui qui s'ouvre", command().file === autre)
  check("le menu suit", shells().find((shell) => shell.current)?.file === autre)
  choose(null)
  check("et on revient au défaut", command().file === accountShell())
}

// ---- ce qui vient de la fenêtre est du texte ----------------------------
//
// Le rendu n'envoie ici qu'un fichier qu'il a lu de `shell:list`. Mais c'est la
// règle partout dans cette application, et sans elle « choisis mon shell »
// devient « lance n'importe quel exécutable de la machine ».
const refuse = (file) => {
  try {
    choose(file)
    return false
  } catch {
    return true
  }
}
check("un exécutable qui n'est pas un shell est refusé", refuse("/usr/bin/curl"))
check("un chemin inventé est refusé", refuse("/tmp/pas-un-shell"))
check("et rien n'a été retenu au passage", chosen() === null)

// ---- un shell qui disparaît --------------------------------------------
//
// Une mise à jour de Homebrew suffit. Le panneau doit alors ouvrir le shell du
// compte, pas échouer à ouvrir quoi que ce soit.
writeFileSync(path.join(userData, "shell.json"), JSON.stringify({ file: "/opt/un-shell-parti/bin/zsh" }))
check("un shell disparu ne retient rien", chosen() === null)
check("et le panneau ouvre celui du compte", command().file === accountShell())

rmSync(userData, { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nLe shell du panneau est celui qu'on a choisi, ou celui du compte." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
