// L'ordre de ce que l'agent dit et de ce qu'il fait.
//
// Le panneau tenait deux listes par message : le texte d'un côté, les appels
// d'outil de l'autre. Il les affichait l'une après l'autre — tous les outils en
// haut, toute la prose en dessous. Quand l'agent parle, appelle un outil, puis
// reparle, l'écran montrait l'outil d'abord et les deux phrases collées après :
// un ordre que personne n'a vécu, et qui donne l'impression que l'agent a agi
// avant d'expliquer.
//
// Ce qui casse en silence ici :
//
// 1. **Deux listes reviennent.** C'est la faute d'origine, et elle ne se voit
//    pas : chaque moitié est juste, seule leur juxtaposition ment.
//
// 2. **Un morceau par fragment reçu.** Le texte arrive en dizaines de morceaux ;
//    en ouvrir un nouveau à chaque fois donnerait un rendu Markdown par
//    fragment, et un paragraphe coupé en confettis.
//
// 3. **Un transcript d'hier.** Il porte l'ancienne forme. Le relire doit rendre
//    ce qui a été vu à l'époque, sans inventer un ordre qu'il n'a pas gardé.
//
//     node scripts/check-agent-order.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-agent-order-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {}, BrowserWindow: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { addText, restoreParts, textOf, toolsOf } from "${path
    .join(ROOT, "src/renderer/panels/AgentPanel")
    .replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: {
    electron: path.join(dir, "electron.js"),
    "@": path.resolve(ROOT, "../Zyvro-frontend/src"),
    "~": path.join(ROOT, "src/renderer"),
  },
  loader: { ".tsx": "tsx" },
  // Le module du site refuse de se charger sans elle : elle est gravée dans le
  // paquet à la compilation, et un site construit sans produirait des appels
  // vers nulle part. Ici on ne fait aucun appel, mais il faut bien répondre.
  define: { "process.env.NEXT_PUBLIC_API_URL": JSON.stringify("http://127.0.0.1:0") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const panel = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const tool = (callId) => ({ kind: "tool", call: { callId, done: `ran ${callId}`, shape: "", detail: "", output: "", isError: false, finished: true } })
const shape = (parts) => parts.map((p) => (p.kind === "text" ? `«${p.text}»` : `[${p.call.callId}]`)).join(" ")

// ---- un tour, tel qu'il se déroule ---------------------------------------
{
  // Il parle, il appelle, il reparle : c'est le cas que l'ancien affichage
  // retournait.
  let parts = []
  parts = panel.addText(parts, "Je regarde ")
  parts = panel.addText(parts, "le fichier.")
  parts = [...parts, tool("read-1")]
  parts = panel.addText(parts, "Il manque une ligne.")
  parts = [...parts, tool("edit-1")]
  parts = panel.addText(parts, "C'est corrigé.")

  check(
    "**ce qui est dit avant un outil reste avant**",
    shape(parts) === "«Je regarde le fichier.» [read-1] «Il manque une ligne.» [edit-1] «C'est corrigé.»",
    shape(parts)
  )
  check(
    "**les fragments d'une même phrase ne font qu'un morceau**",
    parts.filter((p) => p.kind === "text").length === 3,
    `${parts.filter((p) => p.kind === "text").length} morceaux de texte`
  )
  check("et tout ce qui a été dit se relit d'un bloc", panel.textOf({ parts }).startsWith("Je regarde le fichier."))
  check("comme la liste des outils, dans l'ordre", shape(panel.toolsOf({ parts }).map((call) => ({ kind: "tool", call }))) === "[read-1] [edit-1]")
}

// ---- ce qui arrive avant que le tour ait un nom --------------------------
{
  // Les événements peuvent précéder la réponse qui lie le tour à son message ;
  // ils attendent dans un orphelin, et leur ordre doit survivre à l'attente.
  let orphan = []
  orphan = panel.addText(orphan, "Un instant")
  orphan = [...orphan, tool("ls-1")]
  const message = [...[], ...orphan]
  check("**ce qui a attendu garde son ordre**", shape(message) === "«Un instant» [ls-1]", shape(message))
}

// ---- relire un transcript -----------------------------------------------
{
  const ancien = { text: "J'ai lu le fichier.", tools: [{ callId: "r1", done: "read", shape: "", detail: "", output: "", isError: false }] }
  const relu = panel.restoreParts(ancien)
  check(
    "**un transcript d'hier se relit comme il a été vu** (outils, puis texte)",
    shape(relu) === "[r1] «J'ai lu le fichier.»",
    shape(relu)
  )

  const aujourdhui = {
    parts: [
      { kind: "text", text: "Je regarde." },
      { kind: "tool", call: { callId: "r2", done: "read", shape: "", detail: "", output: "", isError: false } },
      { kind: "text", text: "Voilà." },
    ],
  }
  check("**et celui d'aujourd'hui garde le sien**", shape(panel.restoreParts(aujourdhui)) === "«Je regarde.» [r2] «Voilà.»", shape(panel.restoreParts(aujourdhui)))
  check("un message sans rien ne casse rien", panel.restoreParts({}).length === 0)
}

// ---- une seule liste, et elle le reste -----------------------------------
{
  const source = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  check(
    "**l'affichage parcourt la liste des morceaux**",
    source.includes("message.parts.map("),
    "la bulle n'affiche plus les morceaux dans l'ordre"
  )
  check(
    "**et ne tient plus une liste d'outils à part**",
    !/message\.tools\b/.test(source),
    "un `message.tools` est revenu : les deux listes recommencent à diverger"
  )
}

console.log(
  failures === 0
    ? "\nCe que l'agent dit et ce qu'il fait s'affichent dans l'ordre où ils sont arrivés."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
