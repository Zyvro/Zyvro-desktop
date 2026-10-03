// La couleur du chat d'agent, et ce qui ne doit pas casser avec elle.
//
// Demandé par Jeremy : « un peu comme dans codex ou claude code », et un
// indicateur animé tant que l'agent produit. Ce qui casse en silence : un diff
// qui n'est plus reconnu (il redevient gris), une coloration qui passerait par
// du HTML injecté — le texte d'un modèle deviendrait du balisage — et une
// animation qui ne s'arrête pas pour qui a demandé moins de mouvement.
//
//     node scripts/check-chat-colors.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-chat-colors-check")
mkdirSync(dir, { recursive: true })
await build({
  stdin: {
    contents: `export { looksLikeDiff, diffLineClass, HARNESS_TINT } from "${path.join(ROOT, "src/renderer/lib/chatColors").replace(/\\/g, "/")}"\nexport { AGENT_KINDS } from "${path.join(ROOT, "src/shared/harness").replace(/\\/g, "/")}"`,
    resolveDir: ROOT,
  },
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  alias: { "~": path.join(ROOT, "src/renderer"), "@": path.join(ROOT, "../Zyvro-frontend/src") },
  external: ["monaco-editor"],
  logLevel: "silent",
})
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))
const lire = (rel) => readFileSync(path.join(ROOT, rel), "utf8")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- les diffs ----
check("**un diff unifié est reconnu**", mod.looksLikeDiff("@@ -1,2 +1,2 @@\n-a\n+b\n c"))
check("un en-tête de fichier aussi", mod.looksLikeDiff("--- a/x.ts\n+++ b/x.ts\n-a\n+b"))
check("des lignes +/- sans en-tête, quand elles dominent", mod.looksLikeDiff("+ ajouté\n- retiré\n même"))
check("**une sortie ordinaire n'en est pas un**", !mod.looksLikeDiff("  ok    tout passe\n  ok    encore"))
check("une liste à tirets non plus", !mod.looksLikeDiff("voici :\nun\ndeux\ntrois\n- un seul tiret\nfin\nencore\nplus"))
// Les couleurs elles-mêmes viennent du thème choisi (shared/chatThemes).
check(
  "**ajout, retrait et en-tête prennent chacun leur couleur du thème**",
  /--zy-diff-add\)/.test(mod.diffLineClass("+x")) && /--zy-diff-del\)/.test(mod.diffLineClass("-x")) && /--zy-diff-hunk\)/.test(mod.diffLineClass("@@ -1 +1 @@"))
)

// ---- chaque harnais a sa teinte ----
for (const kind of mod.AGENT_KINDS) {
  check(`${kind} a sa couleur`, Boolean(mod.HARNESS_TINT[kind]?.dot && mod.HARNESS_TINT[kind]?.text))
}

// ---- pas de HTML injecté ----
const couleurs = lire("src/renderer/lib/chatColors.tsx")
check(
  "**le code est colorié par des jetons rendus par React, jamais par du HTML**",
  !/dangerouslySetInnerHTML=|\.innerHTML\s*=/.test(couleurs) && /editor\.tokenize\(/.test(couleurs),
  "le texte d'un modèle deviendrait du balisage"
)
const markdown = lire("../Zyvro-frontend/src/components/Markdown.tsx")
check(
  "le Markdown partagé accepte le rendu du code, et le dit en React",
  /renderCode\?: \(code: string, language: string\) => ReactNode/.test(markdown) && !/dangerouslySetInnerHTML=/.test(markdown)
)
const panel = lire("src/renderer/panels/AgentPanel.tsx")
check("**le chat s'en sert**", /className="zy-agent-md text-foreground" compact renderCode=\{renderCode\}/.test(panel))

// ---- « il travaille » ----
check(
  "**tant que l'agent produit, l'indicateur animé est au bout du message**",
  /\{message\.streaming \? <Working verb=\{verb\} kind=\{kind\} \/> : null\}/.test(panel)
)
check("et il dit ce qu'il fait : réfléchir, lancer un outil, écrire", /"Thinking"/.test(panel) && /"Writing"/.test(panel) && /dernier\.call\.running/.test(panel))
const css = lire("src/renderer/styles.css")
check("les animations existent", ["zy-working-star", "zy-shimmer", "zy-dot", "zy-pulse"].every((n) => css.includes(`@keyframes ${n}`)))
check(
  "**et s'arrêtent pour qui demande moins de mouvement**",
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.zy-shimmer[\s\S]*animation: none/.test(css)
)

console.log(failures === 0 ? "\nLe chat est en couleur, et il bouge tant que l'agent travaille." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
