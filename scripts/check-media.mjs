// Les vidéos, les sons, et les réponses lues à voix haute.
//
// Ce qui casse en silence ici :
//
// 1. **Une vidéo qu'on ne peut pas faire avancer.** Un lecteur demande des
//    morceaux (`Range`) ; une réponse 200 avec tout le fichier le lit depuis le
//    début, mais refuse de sauter au milieu.
// 2. **Une adresse qui lit n'importe quoi.** Seul un jeton émis par le
//    principal, pour un fichier vérifié, ouvre quelque chose.
// 3. **Un .mp4 ouvert dans l'éditeur de texte**, qui le déclare binaire.
// 4. **Une politique qui refuse le lecteur** : `media-src` doit connaître le
//    schéma.
// 5. **Une lecture à voix haute qui épelle la syntaxe** — « astérisque
//    astérisque » — ou lit un bloc de code ligne à ligne.
//
//     node scripts/check-media.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-media-play-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { protocol: { registerSchemesAsPrivileged() {}, handle() {} } }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { mediaKindOf, mediaMime, parseRange } from "${from("src/shared/media")}"\n` +
    `export { mediaUrlFor, serve, MEDIA_SCHEME } from "${from("src/main/media")}"\n` +
    `export { speakableText, chunks, guessLang } from "${from("src/renderer/lib/speech")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const m = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- les formats ----
check("**un .mp4 et un .avi sont des vidéos**", m.mediaKindOf("clips/A.MP4") === "video" && m.mediaKindOf("x.avi") === "video")
check("un .mp3 et un .flac sont des sons", m.mediaKindOf("a/b.mp3") === "audio" && m.mediaKindOf("c.flac") === "audio")
check("un .ts ou un fichier sans extension n'en sont pas", m.mediaKindOf("main.ts") === null && m.mediaKindOf("Makefile") === null && m.mediaKindOf(".mp4") === null)
check("le type annoncé suit l'extension", m.mediaMime("a.webm") === "video/webm" && m.mediaMime("b.wav") === "audio/wav")

// ---- les plages ----
check("sans Range : tout le fichier", m.parseRange(null, 100) === null)
const r1 = m.parseRange("bytes=10-19", 100)
check("**bytes=10-19 → 10 à 19**", r1.start === 10 && r1.end === 19)
const r2 = m.parseRange("bytes=90-", 100)
check("bytes=90- → jusqu'au bout", r2.start === 90 && r2.end === 99)
const r3 = m.parseRange("bytes=-5", 100)
check("bytes=-5 → les 5 derniers", r3.start === 95 && r3.end === 99)
check("une fin trop loin est bornée", m.parseRange("bytes=0-9999", 100).end === 99)
check("**au-delà du fichier : invalide (416)**", m.parseRange("bytes=100-", 100) === "invalid" && m.parseRange("bytes=abc", 100) === "invalid")

// ---- le service ----
const tmp = path.join(os.tmpdir(), `zyvro-media-${process.pid}.mp4`)
const octets = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
writeFileSync(tmp, octets)
const url = m.mediaUrlFor(tmp)
check("l'adresse ne porte pas le chemin", url.startsWith(`${m.MEDIA_SCHEME}://media/`) && !url.includes(encodeURIComponent(path.dirname(tmp))))
{
  const res = await m.serve(new Request(url, { headers: { Range: "bytes=100-199" } }))
  const corps = Buffer.from(await res.arrayBuffer())
  check(
    "**une plage rend 206 et exactement ces octets**",
    res.status === 206 && res.headers.get("content-range") === "bytes 100-199/1000" && corps.equals(octets.subarray(100, 200)),
    `${res.status} ${res.headers.get("content-range")} ${corps.length}`
  )
  check("et annonce le type et Accept-Ranges", res.headers.get("content-type") === "video/mp4" && res.headers.get("accept-ranges") === "bytes")
}
{
  const res = await m.serve(new Request(url))
  check("sans plage : 200 et tout le fichier", res.status === 200 && (await res.arrayBuffer()).byteLength === 1000)
}
{
  const res = await m.serve(new Request(url, { headers: { Range: "bytes=5000-" } }))
  check("une plage hors du fichier : 416", res.status === 416)
}
{
  const res = await m.serve(new Request(`${m.MEDIA_SCHEME}://media/pas-un-jeton/x.mp4`))
  check("**un jeton inconnu n'ouvre rien**", res.status === 404)
}

// ---- les branchements ----
const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
const media = ipc.slice(ipc.indexOf('"files:media-url"'), ipc.indexOf('"files:media-url"') + 600)
check(
  "**le principal vérifie le fichier avant d'émettre un jeton**",
  /accorde\(ws, p\) \?\? \(await files\.resolveInside\(requireRoot\(ws\), p\)\)/.test(media) && /mediaKindOf\(p\)/.test(media)
)
const index = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
check(
  "le schéma est déclaré avant que l'app soit prête, et servi après",
  index.indexOf("registerMediaScheme()") < index.indexOf("app.whenReady()") && /whenReady\(\)\.then\(async \(\) => \{\s*handleMedia\(\)/.test(index)
)
const editeur = readFileSync(path.join(ROOT, "src/renderer/panels/EditorArea.tsx"), "utf8")
check("**un fichier vidéo ou son s'ouvre dans le lecteur, pas l'éditeur**", /if \(mediaKindOf\(tab\.path\)\) return <MediaView path=\{tab\.path\} \/>/.test(editeur))
const vue = readFileSync(path.join(ROOT, "src/renderer/panels/MediaView.tsx"), "utf8")
check("ce qui ne se lit pas propose le lecteur du système", /onError=\{onError\}/.test(vue) && /openExternally\(path\)/.test(vue))
const html = readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf8")
check("**media-src autorise le schéma**", /media-src [^;]*zyvro-media:/.test(html))

// ---- lire à voix haute ----
const md = "# Titre\n\nVoici **le plan** pour `npm test` :\n\n- [la doc](https://x.y)\n- *étape* deux\n\n```ts\nconst a = 1\n```\n\nFin."
const dit = m.speakableText(md)
check(
  "**la syntaxe ne se lit pas**",
  !/[*#`\[\]]/.test(dit) && dit.includes("le plan") && dit.includes("npm test") && dit.includes("la doc") && !dit.includes("https"),
  JSON.stringify(dit)
)
check("**un bloc de code est sauté**", !dit.includes("const a"))
check("la langue se devine", m.guessLang("Voici ce que je propose pour la suite, et ce n'est pas tout.") === "fr-FR" && m.guessLang("This is the plan for the next step and it is not done.") === "en-US")
const long = Array.from({ length: 40 }, (_, i) => `Phrase numéro ${i} qui dit quelque chose.`).join(" ")
const morceaux = m.chunks(long, 220)
check("un long texte est coupé en morceaux courts, sans rien perdre", morceaux.every((c) => c.length <= 220) && morceaux.join(" ").replace(/\s+/g, " ") === long)
const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
check(
  "**le bouton est dans l'en-tête de la réponse, au survol, pas dans les outils**",
  /\{kind\}\s*\{!message\.streaming && textOf\(message\)\.trim\(\) !== "" \? <SpeakButton id=\{message\.id\} text=\{textOf\(message\)\} \/> : null\}/.test(panel) &&
    /group-hover\/bulle:opacity-100/.test(panel) &&
    !/<SpeakButton[^>]*call/.test(panel)
)

console.log(failures === 0 ? "\nLes vidéos se lisent, les sons s'écoutent, et les réponses se disent." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
