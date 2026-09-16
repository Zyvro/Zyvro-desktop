// Ce qui est écrit sur le disque quand on colle une image, et ce que l'agent
// peut être amené à lire.
//
// Deux risques, et le second est le vrai. Le premier : écrire un fichier qui
// n'est pas une image sous un nom qui invite à l'ouvrir. Le second : que le
// renderer puisse nommer un chemin. « Voici une image à lire » deviendrait
// alors un moyen de faire lire n'importe quel fichier de la machine par
// l'agent — qui, lui, a le droit de lire.
//
// D'où la règle : le renderer ne voit jamais de chemin. Il nomme une pièce
// jointe par un identifiant, et seul un fichier que ce processus a écrit sous
// le dossier de cette conversation peut ressortir.
//
//     node scripts/check-attachments.mjs
import { build } from "esbuild"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-attach-check")
mkdirSync(dir, { recursive: true })

// electron n'existe pas ici, et le module ne s'en sert que pour savoir où
// écrire. Un faux `app.getPath` suffit, et il pointe dans un dossier temporaire.
const home = mkdtempSync(path.join(os.tmpdir(), "zyvro-attach-"))
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(home)} } }\n`
)
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/main/attachments").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT, logLevel: "silent",
})
const { keep, drop, forget, pathsFor, kindOf, displayName } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

// De vraies en-têtes, pas des approximations.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64)])
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(64)])
// RIFF sans WEBP : un fichier wav commence pareil, et c'est exactement le cas
// qu'un test des quatre premiers octets laisserait passer.
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(64)])

// ---- ce qui est reconnu -------------------------------------------------
check("un PNG est reconnu", kindOf(PNG)?.extension === "png")
check("un JPEG aussi", kindOf(JPEG)?.extension === "jpg")
check("un GIF aussi", kindOf(GIF)?.extension === "gif")
check("un WebP aussi", kindOf(WEBP)?.extension === "webp")
check("un wav qui commence comme un WebP ne l'est pas", kindOf(WAV) === null)
check("du texte n'est pas une image", kindOf(Buffer.from("#!/bin/sh\nrm -rf /")) === null)
check("un fichier vide non plus", kindOf(Buffer.alloc(0)) === null)

// ---- écriture -----------------------------------------------------------
const CONV = "c-test-1"
const kept = await keep(CONV, "capture d'écran.png", PNG)
check("le fichier est écrit", existsSync(kept.file))
check("son nom sur le disque est le nôtre, pas celui reçu", path.basename(kept.file) === `${kept.id}.png`, path.basename(kept.file))
check("le nom affiché garde celui de la personne", kept.name === "capture d'écran.png")
check("le contenu est bien celui envoyé", readFileSync(kept.file).equals(PNG))
check("il est rangé sous la conversation", kept.file.includes(path.join("attachments", CONV)))

const pasted = await keep(CONV, "", PNG)
check("une image collée sans nom en reçoit un, daté", /^pasted-\d{6}\.png$/.test(pasted.name), pasted.name)
check("displayName ne laisse pas passer un chemin", displayName("../../evil.png", "png") === "evil.png")

// ---- ce qui est refusé --------------------------------------------------
for (const [label, bytes] of [["du texte", Buffer.from("plain text")], ["un wav", WAV]]) {
  let refused = ""
  try { await keep(CONV, "truc.png", bytes) } catch (error) { refused = error.message }
  check(`${label} nommé .png est refusé`, /not an image/.test(refused), refused)
}
let tooBig = ""
try { await keep(CONV, "gros.png", Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)])) } catch (error) { tooBig = error.message }
check("une image de plus de 20 Mo est refusée", /limit is 20 MB/.test(tooBig), tooBig)

// ---- la porte : des identifiants, jamais des chemins --------------------
const resolved = pathsFor(CONV, [kept.id, pasted.id])
check("un identifiant connu se résout en chemin", resolved.length === 2 && resolved.includes(kept.file))
check("un identifiant inconnu ne donne rien", pathsFor(CONV, ["00000000-0000-0000-0000-000000000000"]).length === 0)
check("un identifiant d'une autre conversation ne donne rien", pathsFor("c-test-2", [kept.id]).length === 0)
for (const hostile of ["../../../../etc/passwd", "/etc/passwd", "..", ".", "", "  "]) {
  check(
    `un chemin déguisé en identifiant (${JSON.stringify(hostile)}) ne donne rien`,
    pathsFor(CONV, [hostile]).length === 0
  )
}

// ---- retrait ------------------------------------------------------------
await forget(CONV, pasted.id)
check("retirer une image la supprime", !existsSync(pasted.file))
check("et laisse l'autre", existsSync(kept.file))
await drop(CONV)
check("oublier la conversation emporte ses images", !existsSync(kept.file))
check("et son dossier", !existsSync(path.dirname(kept.file)))

rmSync(dir, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? "\nCe qui part vers l'agent est une image, et seulement celles qu'on a écrites." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
