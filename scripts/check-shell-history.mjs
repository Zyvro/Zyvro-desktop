// Les shells qu'on rouvre avec un projet, et ceux qu'on a fermés.
//
// Signalé : « quand j'ouvre un projet où j'avais des shells sauvegardés, que je
// les ferme, puis que je cache le terminal et le rouvre, les shells se
// rouvrent ; pareil si je quitte l'application et la relance alors que je les
// avais fermés. »
//
// Deux causes :
//
// 1. **Fermer un shell ne touchait pas au fichier.** Replier puis rouvrir le
//    terminal le relisait, et les shells fermés revenaient.
//
// 2. **À ⌘Q, le fichier n'était pas réécrit.** `before-quit` n'attend pas une
//    promesse, et l'écriture asynchrone n'avait pas lieu : le fichier gardait
//    la fois d'avant.
//
// Et deux choses à ne pas casser en réparant : changer de projet ne doit pas
// effacer l'historique (seule la croix d'un onglet dit « je n'en veux plus »),
// et un shell rouvert garde l'historique qu'on lui a rendu, sinon il disparaît
// à la deuxième réouverture.
//
//     node scripts/check-shell-history.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-shell-history-check")
mkdirSync(dir, { recursive: true })
const donnees = mkdtempSync(path.join(tmpdir(), "zyvro-shells-"))
writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: { getPath: () => ${JSON.stringify(donnees)}, isPackaged: false } }\n`)
writeFileSync(path.join(dir, "h.ts"), `export { Terminals } from "${path.join(ROOT, "src/main/terminal").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["node-pty"],
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const { Terminals } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Des sessions sans vrai pty : ce qu'on vérifie est le fichier, pas le shell.
const projet = path.join(donnees, "projet")
mkdirSync(path.join(projet, "server"), { recursive: true })
const faux = (t, id, cwd, seen) =>
  t.sessions.set(id, { id, pty: { pid: 0, kill() {} }, cwd, seen, attached: false })

try {
  const t = new Terminals()
  faux(t, "a", projet, "sortie A")
  faux(t, "b", path.join(projet, "server"), "sortie B")
  await t.disposeAll(projet)
  // Le second passage de la fermeture — la fenêtre après `before-quit` — ne
  // trouve plus de shells : il ne doit pas écraser la sauvegarde.
  await t.disposeAll(projet)
  const garde = await t.saved(projet)
  check("**fermer la fenêtre garde les deux shells, même quand la fermeture passe deux fois**", garde.length === 2, JSON.stringify(garde))
  check("**un shell ouvert dans un sous-dossier est gardé aussi**", garde.some((g) => g.seen === "sortie B"))

  // On rouvre : deux shells neufs, semés de leur historique.
  const t2 = new Terminals()
  faux(t2, "c", projet, "sortie A\r\n")
  faux(t2, "d", projet, "sortie B\r\n")
  t2.close("c", projet)
  const apres = await t2.saved(projet)
  check("**fermer un shell à la main le retire de ce qu'on rouvrira**", apres.length === 1 && apres[0].seen.startsWith("sortie B"), JSON.stringify(apres))
  t2.close("d", projet)
  check("**tous fermés : rien à rouvrir, même en repliant le terminal**", (await t2.saved(projet)).length === 0)

  // Changer de projet démonte les onglets, qui appellent `dispose` : le
  // fichier ne bouge pas.
  const t3 = new Terminals()
  faux(t3, "e", projet, "gardé")
  await t3.disposeAll(projet)
  const t4 = new Terminals()
  faux(t4, "f", projet, "gardé")
  t4.dispose("f")
  check("**changer de projet n'efface pas l'historique**", (await t4.saved(projet)).length === 1)
} finally {
  rmSync(donnees, { recursive: true, force: true })
}

const src = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")
check("**l'écriture est synchrone : ⌘Q n'attend pas une promesse**", /writeFileSync\(/.test(src) && /renameSync\(temp, file\)/.test(src) && !/await this\.keepHistory/.test(src))
check("un shell rouvert garde l'historique qu'on lui rend", /const vu = seed \?/.test(src))
const panneau = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
check("la croix d'un onglet le dit au principal", /window\.zyvro\.terminal\.close\(ptyId\)/.test(panneau))
check("et le shell rouvert reçoit son historique", /readStatus\(key\)\.cwd, readStatus\(key\)\.history\)/.test(panneau))

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nUn shell fermé reste fermé ; ceux qu'on a laissés reviennent avec leur historique.")
