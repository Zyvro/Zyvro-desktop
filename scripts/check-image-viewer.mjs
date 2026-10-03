// Une image du chat se regarde en grand, et se retrouve.
//
// Demandé par Jeremy : sur les outils qui lisent une image, pouvoir cliquer
// pour la voir en grand, ouvrir le dossier où elle est, la télécharger. Ce qui
// casse en silence : une vignette qui redevient une simple <img>, un dossier
// qui montre la copie de l'application au lieu de l'original lu, et un chemin
// venu de la fenêtre suivi sans être vérifié.
//
//     node scripts/check-image-viewer.mjs
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const lire = (rel) => readFileSync(path.join(ROOT, rel), "utf8")
let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const thumb = lire("src/renderer/panels/Thumb.tsx")
check("**une vignette s'ouvre en grand au clic**", /onClick=\{\(\) => setOpen\(true\)\}/.test(thumb) && /<ImageViewer/.test(thumb))
check("la vue garde les proportions et tient dans la fenêtre", /object-contain/.test(thumb) && /max-h-\[78vh\]/.test(thumb))
check(
  "**et propose le dossier, l'application, l'enregistrement**",
  /imageReveal\(/.test(thumb) && /imageOpen\(/.test(thumb) && /imageSave\(/.test(thumb)
)

const tool = lire("src/renderer/panels/ToolRow.tsx")
check(
  "**une image lue par un outil pointe vers son original**",
  /source=\{call\.shape === "read" && call\.detail \? call\.detail : undefined\}/.test(tool)
)

const ipc = lire("src/main/ipc.ts")
const bloc = ipc.slice(ipc.indexOf("const imageFile = async"), ipc.indexOf('ipcMain.handle("agent:detach"'))
check(
  "**un chemin venu de la fenêtre n'est suivi que s'il désigne une image qui existe**",
  /stat\?\.isFile\(\)/.test(bloc) && /\\\.\(png\|jpe\?g/.test(bloc),
  bloc.slice(0, 300)
)
check("sinon, c'est la copie rangée par l'application, par identifiant", /attachments\.pathsFor\(String\(conversationId\), \[String\(id\)\]\)/.test(bloc))
check("**le téléchargement passe par une vraie boîte « enregistrer sous »**", /dialog\.showSaveDialog\(win/.test(bloc) && /app\.getPath\("downloads"\)/.test(bloc))
check("et le dossier s'ouvre sur le fichier, sélectionné", /shell\.showItemInFolder\(found\.file\)/.test(bloc))

const preload = lire("src/preload/index.ts")
check("le pont expose les trois gestes", ["agent:image-reveal", "agent:image-open", "agent:image-save"].every((c) => preload.includes(`"${c}"`)))

console.log(failures === 0 ? "\nUne image du chat se regarde en grand, et se retrouve." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
