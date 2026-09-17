// L'arbre de fichiers qui se met à jour tout seul.
//
// Ce qui casse en silence ici :
//
// 1. **Surveiller ce qui n'est pas affiché.** Un `fs.watch` récursif sur un
//    dépôt qui a un `node_modules` ouvre des dizaines de milliers de
//    descripteurs sur macOS et noie le processus. La règle — seulement les
//    dossiers ouverts — n'est pas un confort, et rien dans l'interface ne
//    montrerait qu'elle a été enfreinte.
//
// 2. **Un écouteur qui ne s'arrête pas.** Le rendu dit « . », « src » ou
//    « src/ » selon d'où vient la chaîne. Trois écritures du même dossier, ce
//    sont trois écouteurs, dont deux que plus personne ne sait nommer pour les
//    fermer.
//
// 3. **Une opération, cent réveils.** Écrire un fichier produit plusieurs
//    événements et `git checkout` en produit des centaines. Sans silence
//    d'attente, le dossier est relu autant de fois.
//
// 4. **Un chemin qui sort du projet.** Il vient du rendu : c'est le même
//    portail que la lecture qui doit le refuser, pas une seconde règle écrite
//    ici.
//
//     node scripts/check-watch.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-watch-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {}, BrowserWindow: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/main/watch").replace(/\\/g, "/")}"\n`
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
const watchMod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Un vrai dossier sur le disque : ce qu'on vérifie ici est le comportement de
// `fs.watch`, et un faux système de fichiers ne dirait rien de ce qui casse.
const project = mkdtempSync(path.join(tmpdir(), "zyvro-watch-"))
mkdirSync(path.join(project, "src"))
mkdirSync(path.join(project, "node_modules"))

const seen = []
const watcher = watchMod.createWatcher(
  () => project,
  (relative) => seen.push(relative)
)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// until attend qu'une chose arrive, plutôt qu'un temps fixe.
//
// Le premier événement d'un dossier fraîchement surveillé peut mettre presque
// une seconde à sortir de FSEvents sur macOS. Un `sleep` calibré sur la
// machine de quelqu'un est un test qui échoue une fois sur cinq chez les
// autres, et qu'on finit par relancer sans le lire.
const until = async (predicate, limit = 5000) => {
  const start = Date.now()
  while (Date.now() - start < limit) {
    if (predicate()) return true
    await wait(25)
  }
  return false
}

// settle : le temps qu'il faut pour être sûr que plus rien n'arrivera.
const settle = () => wait(600)

// ---- ce qui est surveillé ------------------------------------------------
{
  await watcher.watch(".")
  await watcher.watch("src")
  check("**seulement ce qu'on a ouvert**", JSON.stringify(watcher.watched()) === '[".","src"]', watcher.watched().join(", "))
  check(
    "**un dossier replié n'est pas surveillé**",
    !watcher.watched().includes("node_modules"),
    watcher.watched().join(", ")
  )

  // Trois écritures du même dossier.
  await watcher.watch("src/")
  await watcher.watch("./src")
  check("**un dossier n'est surveillé qu'une fois, quelle que soit son écriture**", watcher.watched().length === 2, watcher.watched().join(", "))
}

// ---- ce qu'on apprend ----------------------------------------------------
{
  seen.length = 0
  writeFileSync(path.join(project, "src", "a.ts"), "x")
  check(
    "**un fichier écrit réveille son dossier**",
    await until(() => seen.includes("src")),
    JSON.stringify(seen)
  )
  // Et rien d'autre que ce qui est surveillé. On ne vérifie pas que le parent
  // se tait : sur macOS, FSEvents réveille parfois le dossier au-dessus pour
  // une écriture dans un sous-dossier — la largeur d'un événement appartient au
  // système. Ce qui appartient à ce module, c'est la liste de ce qu'il écoute,
  // et un dossier replié ne doit jamais en sortir.
  check(
    "**et jamais un dossier qu'on n'a pas ouvert**",
    seen.every((d) => watcher.watched().includes(d)),
    JSON.stringify(seen)
  )
}

// Une opération produit plusieurs événements ; on n'en veut qu'un.
{
  seen.length = 0
  for (let i = 0; i < 20; i++) writeFileSync(path.join(project, "src", `b${i}.ts`), "x")
  await until(() => seen.includes("src"))
  await settle()
  const forSrc = seen.filter((d) => d === "src").length
  // « Pas vingt » plutôt que « exactement un » : le silence d'attente groupe
  // ce qui arrive en 120 ms, et c'est le système qui décide de l'étalement des
  // événements. Ce qui est vérifié, c'est qu'une opération ne fait pas relire
  // le dossier une fois par fichier.
  check("**vingt fichiers d'un coup ne font pas vingt relectures**", forSrc <= 2, `${forSrc} réveils`)
}

// ---- replier, c'est cesser -----------------------------------------------
{
  watcher.unwatch("src")
  check("**replier ferme l'écouteur**", !watcher.watched().includes("src"), watcher.watched().join(", "))
  seen.length = 0
  writeFileSync(path.join(project, "src", "c.ts"), "x")
  await settle()
  check("et plus rien n'en vient", seen.length === 0, JSON.stringify(seen))

  // Replié sous une autre écriture que celle d'ouverture : c'est le même
  // dossier, il doit se fermer quand même.
  await watcher.watch("src")
  watcher.unwatch("./src/")
  check("**quelle que soit l'écriture du repli**", !watcher.watched().includes("src"), watcher.watched().join(", "))
}

// ---- ce qui vient du rendu n'est pas cru ---------------------------------
{
  const before = watcher.watched().length
  let refused = false
  try {
    await watcher.watch("../..")
  } catch {
    refused = true
  }
  check("**un chemin qui sort du projet est refusé**", refused, "il a été accepté")
  check("et rien ne s'est ajouté", watcher.watched().length === before, watcher.watched().join(", "))
}

// ---- la fenêtre se ferme -------------------------------------------------
{
  await watcher.watch("src")
  watcher.dispose()
  check("**tout se ferme avec la fenêtre**", watcher.watched().length === 0, watcher.watched().join(", "))
  seen.length = 0
  writeFileSync(path.join(project, "src", "d.ts"), "x")
  await settle()
  check("et plus rien n'arrive après", seen.length === 0, JSON.stringify(seen))
}

// ---- sans projet ---------------------------------------------------------
{
  const orphan = watchMod.createWatcher(
    () => null,
    () => {}
  )
  await orphan.watch(".")
  check("**sans projet ouvert, il n'y a rien à surveiller**", orphan.watched().length === 0)
  orphan.dispose()
}

rmSync(project, { recursive: true, force: true })
console.log(
  failures === 0
    ? "\nL'arbre suit les dossiers qu'on a ouverts, une fois chacun, et lâche le reste."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
