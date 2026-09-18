// Ce qu'on lit doit se copier.
//
// Le défaut que ce garde empêche de revenir, signalé en un mot : « gros défaut,
// impossible de copier les textes d'erreur et prompt dans le chat ».
//
// La cause n'était pas un oubli local mais un défaut inversé. `body` portait
// `user-select: none` — une fenêtre d'application ne se sélectionne pas comme
// une page web, ce qui est juste — et ce qui se lit devait le redemander par
// une classe. Sur cinquante composants, deux l'avaient fait. Donc rien de ce
// que l'agent dit ne se copiait : ni sa réponse, ni la commande qu'il propose,
// ni le message d'erreur qu'on voulait justement coller ailleurs.
//
// Un opt-in que deux composants sur cinquante ont fait n'est pas une règle,
// c'est une liste qu'on oublie de tenir. Le sens est donc inversé, et ce garde
// tient les deux bouts :
//
// 1. **Le contenu se sélectionne.** Pas de `user-select: none` global, et rien
//    qui le repose sur un conteneur de texte.
// 2. **La garniture ne se sélectionne pas.** Un bouton dont le libellé se
//    surligne au double-clic n'est pas ce qu'on attend d'une fenêtre.
// 3. **Et il y a de quoi copier au clic droit.** Le raccourci ne suffit pas :
//    il faut y penser, et il n'existait aucun menu contextuel sur la fenêtre de
//    l'application — seulement sur la vue invitée du navigateur.
//
//     node scripts/check-copyable.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-copy-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { appContextTemplate } from "${path.join(ROOT, "src/main/contextmenu").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron", "node-pty"],
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const { appContextTemplate } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const css = readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8")

// ---- le contenu se copie -------------------------------------------------
{
  // Une règle qui coupe la sélection sur `body`, `html`, `#root` ou `*` la coupe
  // partout : tout ce que la personne lit descend de là.
  const global = /(^|\})\s*(\*|html|body|#root)[^{]*\{[^}]*user-select:\s*none/s.test(css)
  check(
    "**rien ne coupe la sélection sur toute la fenêtre**",
    !global,
    "une règle globale remet `user-select: none` : plus rien ne se copie"
  )

  // Et personne ne la coupe sur un conteneur de texte par une classe utilitaire.
  const panneaux = ["src/renderer/panels/AgentPanel.tsx"]
  for (const rel of panneaux) {
    const source = readFileSync(path.join(ROOT, rel), "utf8")
    // `select-none` de Tailwind sur une bulle rendrait le même service que la
    // règle globale, en plus discret.
    const bulles = source.slice(source.indexOf("function Bubble"))
    check(
      `${path.basename(rel)} ne coupe pas la sélection sur ce qu'il affiche`,
      !/select-none/.test(bulles),
      "une bulle porte select-none"
    )
  }
}

// ---- la garniture, elle, ne se sélectionne pas ----------------------------
{
  const retire = css.slice(css.indexOf("button,"), css.indexOf("user-select: none", css.indexOf("button,")) + 30)
  for (const quoi of ["button", '[role="tab"]', '[role="menuitem"]', ".zy-drag"]) {
    check(`la garniture se retire : ${quoi}`, retire.includes(quoi), retire.slice(0, 160))
  }
  // Un nom de modèle ou un chemin, à l'intérieur d'un bouton, doit pouvoir
  // reprendre le dessus.
  check("**mais un texte peut redemander à être pris**", /\.zy-selectable\s*\{[^}]*user-select:\s*text/s.test(css))
}

// ---- de quoi copier au clic droit ----------------------------------------
{
  // Rien de sélectionné, rien à écrire : ouvrir un menu d'une seule ligne
  // grisée n'apprend rien à personne.
  check("**sans rien à copier, aucun menu ne s'ouvre**", appContextTemplate("", false).length === 0)

  const surTexte = appContextTemplate("une erreur qu'on veut coller", false).map((i) => i.role ?? i.type)
  check("**sur une sélection, « Copier » est là**", surTexte.includes("copy"), JSON.stringify(surTexte))
  check(
    "et on ne propose pas de coller là où rien ne s'écrit",
    !surTexte.includes("paste") && !surTexte.includes("cut"),
    JSON.stringify(surTexte)
  )

  const dansUnChamp = appContextTemplate("", true).map((i) => i.role ?? i.type)
  check(
    "**dans un champ, couper et coller le sont aussi**",
    dansUnChamp.includes("paste") && dansUnChamp.includes("cut"),
    JSON.stringify(dansUnChamp)
  )
  check("et « tout sélectionner » ferme la marche", dansUnChamp[dansUnChamp.length - 1] === "selectAll")

  // Les rôles plutôt que des actions écrites à la main : ils portent les
  // raccourcis du système et le grisé quand il n'y a rien à coller.
  const template = appContextTemplate("x", true)
  check(
    "**tout passe par des rôles, pas par des actions à la main**",
    template.every((i) => i.type === "separator" || typeof i.role === "string"),
    JSON.stringify(template)
  )
}

console.log(
  failures === 0
    ? "\nCe que la fenêtre affiche se sélectionne, et le clic droit sait le copier."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
