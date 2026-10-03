// Les shells ne rouvrent plus avec un projet.
//
// Demande de Jeremy : « supprime la save de shell ouvert et ne reouvre pas les
// shells quand on reouvre le projet. meme pour les shells persistent on les
// gardent seulement affichee dans la liste. »
//
// Ce qui casse en silence ici :
//
// 1. **Un fichier d'historique qui revient.** La moitié du chemin (l'écriture
//    à la fermeture) et l'autre moitié (la lecture à l'ouverture) doivent
//    partir ensemble. N'en retirer qu'une laisse un fichier mort ou un restore
//    qui lit un fichier qu'on n'écrit plus — et les shells reviennent le jour
//    où quelqu'un réaccroche l'autre bout.
//
// 2. **Les persistants qui se rouvrent quand même.** `disposeProject` doit
//    détacher leurs clients, et `reprendre` ne doit adopter que des ptys
//    encore vivants (rechargement du rendu), jamais en recréer.
//
// 3. **Le badge des sections repliées.** Browser / Persistent / Workflows
//    doivent dire combien d'éléments elles contiennent même fermées.
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

const projet = path.join(donnees, "projet")
mkdirSync(projet, { recursive: true })
const faux = (t, id, cwd, seen, attached = false) =>
  t.sessions.set(id, { id, pty: { pid: 0, kill() {} }, cwd, seen, attached })

try {
  const t = new Terminals()
  faux(t, "a", projet, "sortie A")
  faux(t, "p", projet, "persistant", true)
  await t.disposeAll(projet)
  check(
    "**fermer la fenêtre ne laisse rien à rouvrir**",
    typeof t.saved !== "function",
    "saved() est encore là : le chemin de réouverture n'est pas parti"
  )
  check("et les shells sont bien morts", t.sessions.size === 0)

  // Fermer un projet détache aussi les clients persistants : la liste latérale
  // reste la seule porte d'entrée.
  const t2 = new Terminals()
  faux(t2, "b", projet, "ordinaire")
  faux(t2, "c", projet, "persistant", true)
  t2.disposeProject(projet)
  check(
    "**fermer le projet détache les persistants**",
    t2.sessions.size === 0,
    `${t2.sessions.size} session(s) restante(s) — un onglet rouvrirait tout seul`
  )
} finally {
  rmSync(donnees, { recursive: true, force: true })
}

const src = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")
const panneau = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
const preload = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8")

check("**plus d'écriture d'historique**", !src.includes("keepHistory") && !src.includes("historyFile"))
check("plus de lecture non plus", !src.includes("async saved(") && !ipc.includes("terminal:saved"))
check("et le pont ne l'expose plus", !preload.includes("terminal:saved"))
check(
  "**le panneau ne recrée pas de shells**",
  !panneau.includes("terminal.saved") && !panneau.includes("session précédente"),
  "la restauration depuis le fichier est revenue"
)
check(
  "il adopte seulement les ptys vivants",
  panneau.includes("if (vivants.length === 0) return") && panneau.includes("vivant.pty")
)

// ---- les sections repliables ---------------------------------------------
{
  const section = readFileSync(path.join(ROOT, "src/renderer/panels/SidebarSection.tsx"), "utf8")
  check(
    "**une section repliable compte ses éléments**",
    section.includes("data-section-toggle") && section.includes("count > 0"),
    "le badge ne dirait pas s'il y en a"
  )
  for (const [fichier, id] of [
    ["BrowserList", "browser"],
    ["PersistentList", "persistent"],
    ["WorkflowList", "workflows"],
  ]) {
    const src2 = readFileSync(path.join(ROOT, `src/renderer/panels/${fichier}.tsx`), "utf8")
    check(
      `**${fichier} est repliable et compte**`,
      src2.includes("SidebarSection") && src2.includes(`id="${id}"`) && src2.includes("count="),
      `${fichier} n'a pas le collapse ou le badge`
    )
  }
}

console.log(
  failures === 0
    ? "\nUn projet qu'on rouvre n'a plus de shells ; les persistants restent dans leur liste."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
