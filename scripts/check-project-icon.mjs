// L'icône d'un projet, et le projet vers lequel part un prompt.
//
// Ce qui casse en silence ici :
//
// 1. **Une icône générée qui change.** Elle sert à reconnaître un projet sans
//    lire son nom : si sa couleur bougeait d'un lancement à l'autre, elle ne
//    servirait à rien. Et deux dossiers du même nom doivent se distinguer.
//
// 2. **Une image écrite telle quelle.** Une photo de 12 Mo dans `.zyvro/` part
//    dans le dépôt. On garde un carré de 128 px, recadré par le centre.
//
// 3. **Un chemin accepté sans vérification.** Le rendu nomme le projet ; s'il
//    pouvait nommer n'importe quel dossier, il écrirait `.zyvro/icon.png`
//    n'importe où.
//
//     node scripts/check-project-icon.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-project-icon-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
const require = createRequire(import.meta.url)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- l'icône générée -----------------------------------------------------------
await build({
  entryPoints: [from("src/shared/projectIcon.ts")],
  outfile: path.join(dir, "shared.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
})
const s = require(path.join(dir, "shared.cjs"))
{
  const cas = { Zyvro: "ZY", "my-app": "MA", my_app: "MA", myApp: "MA", "My App": "MA", golf: "GO", x: "X", "été-projet": "ÉP", "": "?", "---": "?" }
  for (const [nom, attendu] of Object.entries(cas)) check(`« ${nom} » → ${attendu}`, s.projectLetters(nom) === attendu, s.projectLetters(nom))
  const a = s.generatedIcon("app", "/Users/me/work/app")
  check("**la même icône à chaque fois pour le même projet**", JSON.stringify(a) === JSON.stringify(s.generatedIcon("app", "/Users/me/work/app")))
  check("**deux dossiers du même nom ont deux couleurs**", a.background !== s.generatedIcon("app", "/Users/me/perso/app").background)
  check("une couleur CSS", /^hsl\(\d+ \d+% \d+%\)$/.test(a.background), a.background)
  check("l'icône choisie vit dans le projet", s.PROJECT_ICON_FILE === ".zyvro/icon.png")
}

// ---- l'image choisie, dans un vrai Electron ------------------------------------
//
// `nativeImage` n'existe que dans Electron : le recadrage s'éprouve là, sans
// fenêtre, avec une image large qu'on fabrique ici.
{
  await build({
    entryPoints: [from("src/main/projecticon.ts")],
    outfile: path.join(dir, "projecticon.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    external: ["electron"],
    logLevel: "silent",
  })
  const projet = mkdtempSync(path.join(os.tmpdir(), "zyvro-icon-"))
  const sortie = path.join(projet, "resultat.json")
  writeFileSync(
    path.join(dir, "run.cjs"),
    `const { app, nativeImage } = require("electron")
const fs = require("node:fs"), path = require("node:path")
const m = require(${JSON.stringify(path.join(dir, "projecticon.cjs"))})
app.whenReady().then(async () => {
  const out = {}
  try {
    // 400 × 200 : à gauche rouge, au centre vert, à droite bleu.
    const w = 400, h = 200, buf = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, c = x < 100 ? [0, 0, 255] : x < 300 ? [0, 255, 0] : [255, 0, 0]
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255
    }
    const large = path.join(${JSON.stringify(projet)}, "large.png")
    fs.writeFileSync(large, nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG())
    const url = await m.setProjectIcon(${JSON.stringify(projet)}, large)
    const ecrit = nativeImage.createFromPath(path.join(${JSON.stringify(projet)}, ".zyvro", "icon.png"))
    const px = ecrit.toBitmap()
    out.size = ecrit.getSize()
    out.corner = [px[0], px[1], px[2]]
    out.dataUrl = url.startsWith("data:image/png;base64,")
    out.read = (await m.readProjectIcon(${JSON.stringify(projet)})) === url
    const texte = path.join(${JSON.stringify(projet)}, "pas-une-image.png")
    fs.writeFileSync(texte, "bonjour")
    try { await m.setProjectIcon(${JSON.stringify(projet)}, texte); out.refused = false } catch (e) { out.refused = String(e.message) }
    out.keptAfterRefusal = (await m.readProjectIcon(${JSON.stringify(projet)})) === url
    await m.clearProjectIcon(${JSON.stringify(projet)})
    out.cleared = (await m.readProjectIcon(${JSON.stringify(projet)})) === null
  } catch (e) { out.error = String(e && e.stack || e) }
  fs.writeFileSync(${JSON.stringify(sortie)}, JSON.stringify(out))
  app.quit()
})
`
  )
  const electron = require("electron")
  try {
    execFileSync(electron, [path.join(dir, "run.cjs")], { stdio: "ignore", timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } })
  } catch {
    // Le résultat dit ce qui s'est passé ; un code de sortie seul ne le dit pas.
  }
  if (!existsSync(sortie)) {
    check("Electron a lancé l'essai", false, "aucun résultat écrit")
  } else {
    const r = JSON.parse(readFileSync(sortie, "utf8"))
    check("l'essai a tourné", !r.error, r.error)
    check("**l'image est réduite à un carré de 128 px**", r.size?.width === 128 && r.size?.height === 128, JSON.stringify(r.size))
    // toBitmap est en BGRA : un coin vert dit que le recadrage a pris le centre.
    check("**recadrée par le centre, pas par un bord**", r.corner?.[0] < 40 && r.corner?.[1] > 200 && r.corner?.[2] < 40, JSON.stringify(r.corner))
    check("et relue telle qu'écrite", r.dataUrl === true && r.read === true)
    check("**ce qui n'est pas une image est refusé, avec ce qu'il faut choisir**", typeof r.refused === "string" && /PNG or a JPEG/.test(r.refused), String(r.refused))
    check("sans abîmer l'icône déjà là", r.keptAfterRefusal === true)
    check("revenir à la générée retire le fichier", r.cleared === true)
  }
}

// ---- le chemin, le panneau, la barre ---------------------------------------------
{
  const ipc = readFileSync(from("src/main/ipc.ts"), "utf8")
  check(
    "**un chemin n'est accepté que s'il est un projet ouvert dans cette fenêtre**",
    /ws\.list\(\)\.find\(\(p\) => p\.project === wanted\)/.test(ipc) &&
      ["project:icon", "project:choose-icon", "project:clear-icon"].every((c) => new RegExp(`"${c}", async \\(event, project: unknown\\) =>[\\s\\S]{0,80}openProjectFor\\(event, project\\)`).test(ipc))
  )
  check("une icône changée est dite à toutes les fenêtres", /webContents\.send\("project:icon-changed"/.test(ipc))
  const panel = readFileSync(from("src/renderer/panels/AgentPanel.tsx"), "utf8")
  check("**la boîte de l'agent dit où part le prompt**", /\{projet && <PromptProject project=\{projet\.project\} name=\{projet\.name\} \/>\}/.test(panel))
  check("c'est le projet au premier plan", /const projet = useWorkspace\(\(s\) => s\.project\)/.test(panel))
  const barre = readFileSync(from("src/renderer/panels/TitleBar.tsx"), "utf8")
  check("**la même icône dans la barre des projets**", /<ProjectIcon project=\{path\} name=\{name\}/.test(barre))
}

console.log(failures === 0 ? "\nChaque projet a son icône, et la boîte de l'agent dit où part ce qu'on tape." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
