// Le champ de vision sous le curseur, et la hauteur libre du terminal.
//
// Demande de Jeremy : « un leger indicateur de zone de survol quand on survol
// une zone de l'editeur » et « permettre de deplacer la window de shells sur
// toute la hauteur ».
//
// Ce qui casse en silence ici :
//
// 1. **Le plafond de 640 px.** Un terminal borné à 640 reste bloqué à ~70 %
//    d'un grand écran. Son max doit suivre la fenêtre.
//
// 2. **`Window` pris pour un champ de vision.** La zone racine englobe tout :
//    l'indicateur allumait toute la fenêtre et ne disait rien. Seule la plus
//    petite zone sous le curseur compte.
//
// 3. **Un liseré trop fort.** « Un tout petit peu » — pas un fond, pas un nom,
//    pas le mode capture.
//
//     node scripts/check-zone-hover.mjs
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const app = readFileSync(path.join(ROOT, "src/renderer/App.tsx"), "utf8")
const hover = readFileSync(path.join(ROOT, "src/renderer/panels/ZoneHover.tsx"), "utf8")

// ---- la hauteur du terminal -----------------------------------------------
{
  check(
    "**le terminal n'a plus de plafond à 640**",
    !/terminal:\s*\[120,\s*640\]/.test(app) && /terminalMax\(\)/.test(app),
    "le panneau shells reste bloqué sous 70 % d'un grand écran"
  )
  check(
    "et son maximum suit la fenêtre",
    /window\.innerHeight/.test(app) && /Math\.max\(200, window\.innerHeight/.test(app),
    "un max fixe relock la hauteur sur les petits écrans"
  )
}

// ---- l'indicateur de champ de vision --------------------------------------
{
  check(
    "**il montre la zone sous le curseur**",
    hover.includes("zoneAt(findZones()") && hover.includes("data-zone-hover"),
    "rien ne dit où est le champ de vision"
  )
  check(
    "**`Window` n'est pas un champ de vision**",
    hover.includes('z.name !== "Window"'),
    "l'indicateur allumerait la fenêtre entière"
  )
  check(
    "et le liseré reste léger",
    /0 0 0 1px rgb\(56 189 248 \/ 0\.22\)/.test(hover) && !hover.includes("bg-primary"),
    "un fond ou un nom serait le mode capture, pas un coup d'œil"
  )
  check("il est monté dans l'app", app.includes("<ZoneHover />"))
}

console.log(
  failures === 0
    ? "\nLe champ de vision se voit d'un liseré ; le terminal prend toute la hauteur."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
