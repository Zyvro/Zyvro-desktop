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

// ---- les onglets retrouvés au redémarrage -------------------------------------------
check(
  "les shells repris retrouvent leurs onglets : côte à côte, ils le redeviennent",
  j(t.withRestored([], ["a", "b", "c"], [0, 0, 1])) === j([["a", "b"], ["c"]])
)
check("sans numéro (un fichier d'avant), chacun son onglet", j(t.regroup(["a", "b"], [undefined, undefined])) === j([["a"], ["b"]]))
check("un même numéro qui ne se suit pas ne fusionne pas", j(t.regroup(["a", "b", "c"], [0, 1, 0])) === j([["a"], ["b"], ["c"]]))
check(
  "dans l'ordre des onglets, pas dans celui de la création",
  j(t.inLayoutOrder(["s1", "s2", "s3"], [["s1", "s3"], ["s2"]])) === j([{ id: "s1", tab: 0 }, { id: "s3", tab: 0 }, { id: "s2", tab: 1 }])
)
check(
  "un shell que la disposition ne connaît pas a son onglet, après",
  j(t.inLayoutOrder(["x", "s1"], [["s1"]])) === j([{ id: "s1", tab: 0 }, { id: "x", tab: 1 }])
)
check("un shell fermé depuis ne laisse pas de trou qui gêne", j(t.regroup(["s1", "s3"], [0, 2])) === j([["s1"], ["s3"]]))
{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  const term = lire("src/main/terminal.ts")
  check("le principal écrit l'onglet de chaque shell, dans l'ordre des onglets", /inLayoutOrder\(\s*retenus\.map/.test(term) && /\s+tab,\s*\}\)\)/.test(term))
  check("et rend les vivants dans cet ordre", /running\(cwd: string\)[\s\S]*?inLayoutOrder\(/.test(term))
  const panel = lire("src/renderer/panels/TerminalPanel.tsx")
  check("le rendu envoie la disposition quand les onglets ou les identifiants changent", /window\.zyvro\.terminal\.layout\(layout\)/.test(panel) && /if \("ptyId" in patch\) window\.queueMicrotask\(envoyerDisposition\)/.test(panel))
  check("et regroupe ce qu'il reprend", /passe\.map\(\(shell\) => shell\.tab\)/.test(panel) && /vivants\.map\(\(vivant\) => vivant\.tab\)/.test(panel))
}

// ---- la séparation qui se tire -----------------------------------------------------
{
  const p = t.placeIn([1, 1, 2], 2)
  check("chaque shell prend sa part", p.left === 0.5 && p.width === 0.5)
  check("à parts égales par défaut", t.placeIn([1, 1], 1).left === 0.5)
  const r = t.resizePair([1, 1, 1], 0, 0.5, 0.3)
  check("**tirer donne à l'un ce que l'autre perd, sans toucher les autres**", JSON.stringify(r) === JSON.stringify([1.5, 0.5, 1]))
  const proche = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9)
  check("**aucun ne disparaît sous le minimum**", proche(t.resizePair([1, 1], 0, 5, 0.2), [1.8, 0.2]))
  check("vers la gauche aussi", proche(t.resizePair([1, 1], 0, -5, 0.2), [0.2, 1.8]))
}

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
