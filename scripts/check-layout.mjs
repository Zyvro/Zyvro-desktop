// La disposition de la fenêtre, et les projets rouverts au lancement.
//
// Demandé : « déplacer les fichiers de la gauche à la droite, et les projets
// en haut / à gauche / à droite », puis « à la réouverture, ouvrir les projets
// qui étaient ouverts ». Ce qui casse en silence ici :
//
// 1. **Déplacer un panneau le remonte.** Chaque pièce garde sa place dans
//    l'arbre React et ne change que d'ordre CSS ; sinon l'explorateur perdrait
//    ses dossiers dépliés et le Shell ses processus.
// 2. **Une préférence abîmée casse la fenêtre.** Lue du stockage, elle est
//    toujours ramenée à une valeur connue.
// 3. **La croix d'un projet inactif ferme l'actif.** closeProject ne connaît
//    que le projet regardé : closeProjectAt bascule d'abord.
// 4. **La liste des projets se vide à la fermeture.** Elle n'est écrite que
//    sur un geste (ouvrir, fermer, basculer), jamais quand la fenêtre se défait.
//
//     node scripts/check-layout.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
let failures = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`)
  if (!ok) failures++
}
const read = (p) => readFileSync(path.join(ROOT, p), "utf8")

const work = mkdtempSync(path.join(tmpdir(), "zyvro-layout-"))
const userData = path.join(work, "userData")
mkdirSync(userData)
const fake = path.join(work, "electron.cjs")
writeFileSync(fake, `module.exports = { app: { getPath: () => ${JSON.stringify(userData)}, addRecentDocument() {}, clearRecentDocuments() {} } }\n`)
const entry = path.join(work, "entry.ts")
writeFileSync(
  entry,
  `export { sanitizeLayout } from ${JSON.stringify(path.join(ROOT, "src/renderer/state/layoutPrefs"))}\n` +
    `export { saveSession, loadSession } from ${JSON.stringify(path.join(ROOT, "src/main/recents"))}\n`
)
const out = path.join(work, "out.cjs")
await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: out, alias: { electron: fake }, logLevel: "silent" })
const mod = createRequire(import.meta.url)(out)

// ---- la préférence
{
  const d = mod.sanitizeLayout(null)
  check("par défaut : fichiers à gauche, projets en onglets", d.sidebar === "left" && d.projects === "top")
  const bad = mod.sanitizeLayout({ sidebar: "middle", projects: "bottom", projectsWidth: 99999 })
  check("**une préférence abîmée revient à une valeur connue**", bad.sidebar === "left" && bad.projects === "top" && bad.projectsWidth === 480)
  const ok = mod.sanitizeLayout({ sidebar: "right", projects: "left", projectsWidth: 300 })
  check("une préférence valide est gardée", ok.sidebar === "right" && ok.projects === "left" && ok.projectsWidth === 300)
}

// ---- la mise en page
{
  const app = read("src/renderer/App.tsx")
  check("**les pièces changent d'ordre CSS, pas de place dans l'arbre**", /order: order\.sidebar/.test(app) && /order: order\.centre/.test(app) && /order: order\.activity/.test(app) && /order: order\.projects/.test(app))
  check("le séparateur des fichiers tire dans le bon sens des deux côtés", /side === "left" \? delta : -delta/.test(app))
  const bar = read("src/renderer/panels/TitleBar.tsx")
  check("le menu Layout propose les deux côtés et les trois places", /"Panel on the left"/.test(bar) && /"Panel on the right"/.test(bar) && /"Tabs at the top"/.test(bar))
  check("**projets en panneau : plus d'onglets en haut**", /!enOnglets \? null/.test(bar))
  check("**la croix d'un onglet ferme CE projet**", /closeProjectAt\(path\)/.test(bar) && !/onClick=\{\(\) => void closeProject\(\)\}/.test(bar))
  const proj = read("src/renderer/lib/project.ts")
  check("closeProjectAt bascule d'abord sur le projet à fermer", /export async function closeProjectAt[\s\S]{0,300}switchProject\(dir\)/.test(proj))
}

// ---- les projets rouverts
{
  const existe = path.join(work, "a")
  const autre = path.join(work, "b")
  mkdirSync(existe)
  mkdirSync(autre)
  mod.saveSession({ projects: [existe, autre, path.join(work, "disparu")], active: autre })
  const s = mod.loadSession()
  check("**les projets ouverts reviennent, dans l'ordre, avec l'actif**", s.projects.join() === [existe, autre].join() && s.active === autre, JSON.stringify(s))
  rmSync(autre, { recursive: true })
  const t = mod.loadSession()
  check("un projet effacé depuis n'est pas rouvert, ni gardé actif", t.projects.join() === existe && t.active === null, JSON.stringify(t))
  writeFileSync(path.join(userData, "open-projects.json"), "{pas du json")
  check("un fichier abîmé ne rouvre rien, sans erreur", mod.loadSession().projects.length === 0)
  const ipc = read("src/main/ipc.ts")
  const notes = (ipc.match(/noteSession\(ws\)/g) ?? []).length
  check("**écrite à l'ouverture, à la bascule et à la fermeture d'un projet**", notes >= 3, String(notes))
  const main = read("src/main/index.ts")
  check("rouverts une fois, dans la première fenêtre, sans dossier nommé", /!startupFolder && !sessionRestored \? loadSession\(\)/.test(main))
  const bridge = read("src/renderer/lib/menuBridge.ts")
  check("un à un, puis celui qu'on regardait", /for \(const dir of session\.projects\)[\s\S]{0,120}await openProject\(dir\)[\s\S]{0,120}switchProject\(session\.active\)/.test(bridge))
}

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? "\nLes panneaux vont où on les veut, et les projets reviennent au lancement." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
