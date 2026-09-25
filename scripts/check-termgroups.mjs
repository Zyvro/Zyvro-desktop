// Le terminal scindé : des shells côte à côte dans un onglet, comme VS Code.
//
// Ce qui casse en silence ici :
//
// 1. **Un shell tué par la mise en page.** Emboîter les shells d'un onglet
//    dans un conteneur les démonterait — pty compris — dès que l'onglet change
//    de forme. Chaque shell reste un enfant direct, sous sa propre clé.
// 2. **La main perdue.** Fermer le shell qu'on regarde donne la main à son
//    voisin dans l'onglet, pas à un autre onglet.
//
//     node scripts/check-termgroups.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-termgroups-check")
mkdirSync(dir, { recursive: true })
await build({
  entryPoints: [path.join(ROOT, "src/shared/termgroups.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
})
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const j = (g) => JSON.stringify(g)

let g = t.addGroup([], "a")
g = t.addGroup(g, "b")
check("un onglet par shell", j(g) === j([["a"], ["b"]]))
g = t.splitBeside(g, "a", "c")
check("**Split : à droite du shell qu'on regarde, dans son onglet**", j(g) === j([["a", "c"], ["b"]]))
g = t.splitBeside(g, "a", "d")
check("juste à sa droite, pas au bout", j(g) === j([["a", "d", "c"], ["b"]]))
check("sans shell à côté de qui se mettre : un onglet", j(t.splitBeside([], "x", "y")) === j([["y"]]))

let r = t.removeKey(g, "d")
check("**fermer un shell partagé laisse les autres**", j(r.groups) === j([["a", "c"], ["b"]]))
check("et la main va à son voisin", r.fallback === "c")
r = t.removeKey(r.groups, "b")
check("le dernier d'un onglet emporte l'onglet", j(r.groups) === j([["a", "c"]]) && r.fallback === "a")
r = t.removeKey([["a"]], "a")
check("plus rien", j(r.groups) === j([]) && r.fallback === "")

check(
  "les shells repris d'abord, chacun son onglet, puis ceux venus entre-temps",
  j(t.withRestored([["n", "m"]], ["r1", "r2"])) === j([["r1"], ["r2"], ["n", "m"]])
)
check("un repris déjà là n'est pas en double", j(t.withRestored([["r1", "m"]], ["r1"])) === j([["r1"], ["m"]]))

{
  const panneau = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  check(
    "**chaque shell est un enfant direct, sous sa clé**",
    /\{sessions\.map\(\(key\) => \{\s*const group = groupOf\(groups, key\)/.test(panneau) &&
      /<TerminalSession sessionKey=\{key\} active=\{visible\} \/>/.test(panneau)
  )
  const pont = readFileSync(path.join(ROOT, "src/renderer/lib/menuBridge.ts"), "utf8")
  check("⌘\\ dans le terminal le scinde", /closest\("\[data-terminal-panel\]"\)\) requestTerminalSplit\(\)/.test(pont))
  const menu = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check("View › Split Terminal", /label: "Split Terminal"/.test(menu))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nDeux shells côte à côte, et fermer l'un ne touche pas l'autre.")
