// La capture d'écran de la barre de menus.
//
// Ce qui casse en silence ici :
//
// 1. **L'écran de quelqu'un donné à un agent.** Le serveur de captures de
//    l'agent photographie « les fenêtres de l'application ». Si la fenêtre de
//    résultat en faisait partie, un agent recevrait ce que la personne vient
//    de capturer sur son écran. Rien ne le montrerait : l'image aurait l'air
//    d'une capture de Studio comme une autre.
//
// 2. **Un GIF qui ment sur sa durée.** Le serveur refuse au-delà d'une
//    minute, en additionnant les délais. Un GIF dont les délais ne suivent pas
//    l'horloge serait refusé pour un enregistrement de cinquante secondes, ou
//    accepté pour deux minutes.
//
// 3. **La zone au mauvais endroit.** Elle se choisit en points et se découpe
//    en pixels ; sur un écran Retina, oublier le rapport donne une image du
//    quart supérieur gauche, nette et fausse.
//
// 4. **Un lien qui n'en est pas un dans le presse-papier.** Ce que le serveur
//    rend y part sans qu'on le relise.
//
//     node scripts/check-capture.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-capture-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${rel("src/shared/capture")}"\nexport { GifClip } from "${rel("src/shared/gifclip")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))
const read = (p) => readFileSync(path.join(ROOT, p), "utf8")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- 1. aucun chemin de l'agent vers l'écran ------------------------------
{
  const imports = (file) => /from "\.\/capture"/.test(read(file))
  for (const file of ["src/main/shots.ts", "src/main/mcp.ts", "src/main/agent.ts", "src/main/browser.ts", "src/main/tooltalk.ts"]) {
    check(`${file} n'importe pas la capture d'écran`, !imports(file))
  }
  const index = read("src/main/index.ts")
  check(
    "**le serveur de captures de l'agent ne voit que les fenêtres de Studio**",
    /startShotsServer\(\(\) => studioWindows\(\)/.test(index) && !/startShotsServer\(\(\) => BrowserWindow\.getAllWindows/.test(index)
  )
  check("**chaque fenêtre de capture est marquée comme telle**", /markCaptureWindow\(win\)/.test(read("src/main/capture.ts")))
  const ipc = read("src/main/ipc.ts")
  const ask = ipc.slice(ipc.indexOf("export const askHost"), ipc.indexOf("const workspaces"))
  check("une question de l'agent va à une fenêtre de Studio", /studioWindows\(\)/.test(ask) && !/getAllWindows/.test(ask))
  check("le cycle de vie ignore les fenêtres de capture", !/BrowserWindow\.getAllWindows\(\)/.test(index))
}

// ---- le pont des fenêtres de capture --------------------------------------
{
  const bridge = read("src/preload/capture.ts")
  const channels = [...bridge.matchAll(/invoke(?:<[^>]*>)?\(\s*([^,)]+)/g)].map((m) => m[1].trim())
  // `ipcRenderer.invoke(channel, …)` est le seul appel direct : celui qui nettoie.
  const calls = channels.filter((c) => c !== "channel" && c !== "channel: string")
  check(
    "**le pont de capture ne nomme que des opérations**",
    calls.length > 0 && calls.every((c) => /^"capture:[a-z-]+"$/.test(c)),
    calls.filter((c) => !/^"capture:[a-z-]+"$/.test(c)).join(", ")
  )
  const main = read("src/main/capture.ts")
  // Chaque opération d'une fenêtre de capture vérifie qui la demande.
  const scoped = [
    "capture:overlay-info", "capture:select", "capture:recorder-config", "capture:recorder-started",
    "capture:recorded", "capture:record-failed", "capture:stop-request", "capture:current",
    "capture:copy-image", "capture:save", "capture:publish", "capture:copy-text", "capture:reveal",
    "capture:open-studio", "capture:close",
  ]
  const unchecked = scoped.filter((channel) => {
    const at = main.indexOf(`ipcMain.handle("${channel}"`)
    if (at < 0) return true
    const next = main.indexOf("ipcMain.handle(", at + 10)
    const body = main.slice(at, next < 0 ? main.length : next)
    return !/sentBy\(event|fromResult\(event|overlays\.values\(\)\]\.find\(\(\{ win \}\) => sentBy/.test(body)
  })
  check("**chaque opération vérifie la fenêtre qui la demande**", unchecked.length === 0, unchecked.join(", "))
  check("le presse-papier ne reçoit qu'un lien rendu pour cette capture", /links\.includes\(text\)/.test(main))
  const html = read("src/renderer/capture.html")
  check("la page de capture porte sa politique", /script-src 'self'/.test(html) && /media-src 'self' blob:/.test(html))
}

// ---- 3. la zone ---------------------------------------------------------------
{
  check("**un clic n'est pas une zone**", t.selectionRect({ x: 10, y: 10 }, { x: 13, y: 12 }, { width: 100, height: 100 }) === null)
  const drag = t.selectionRect({ x: 80, y: 90 }, { x: 20, y: 30 }, { width: 100, height: 100 })
  check("un tracé vers le haut à gauche donne la même zone", drag && drag.x === 20 && drag.y === 30 && drag.width === 60 && drag.height === 60)
  const out = t.selectionRect({ x: 50, y: 50 }, { x: 500, y: -40 }, { width: 100, height: 100 })
  check("la zone reste dans l'écran", out && out.x === 50 && out.y === 0 && out.width === 50 && out.height === 50)

  const retina = t.pixelRect({ x: 100, y: 50, width: 200, height: 100 }, { width: 1440, height: 900 }, { width: 2880, height: 1800 })
  check("**Retina : la zone en pixels est le double**", retina.x === 200 && retina.y === 100 && retina.width === 400 && retina.height === 200, JSON.stringify(retina))
  const smaller = t.pixelRect({ x: 0, y: 0, width: 1440, height: 900 }, { width: 1440, height: 900 }, { width: 1280, height: 800 })
  check("une piste plus petite que l'écran : le rapport se lit sur elle", smaller.width === 1280 && smaller.height === 800)
  const edge = t.pixelRect({ x: 1400, y: 880, width: 100, height: 100 }, { width: 1440, height: 900 }, { width: 1440, height: 900 })
  check("une zone au bord ne déborde pas de l'image", edge.x + edge.width <= 1440 && edge.y + edge.height <= 900)

  const fit = t.fitWithin(3023, 1963, t.VIDEO_MAX_SIDE)
  check("**la vidéo tient dans 1920 et ses côtés sont pairs**", fit.width <= 1920 && fit.width % 2 === 0 && fit.height % 2 === 0, JSON.stringify(fit))
  const small = t.fitWithin(301, 201, t.VIDEO_MAX_SIDE)
  check("une petite zone n'est pas agrandie", small.width === 300 && small.height === 200)
  check("le GIF tient dans 640 de large", t.gifSize(1920, 1080).width === 640 && t.gifSize(400, 300).width === 400)
}

// ---- les réglages -------------------------------------------------------------
{
  const d = t.sanitizeCapture(null)
  check("**démarrer avec la session : non par défaut**", d.launchAtLogin === false && d.loginAsked === false)
  check("pas de copie locale par défaut", d.keepDir === null)
  const bad = t.sanitizeCapture({ keepDir: "captures", shortcutImage: "A", shortcutVideo: "Shift", launchAtLogin: "yes" })
  check("un dossier relatif est refusé", bad.keepDir === null)
  check("**une lettre seule n'est pas un raccourci global**", bad.shortcutImage === t.DEFAULT_CAPTURE.shortcutImage && bad.shortcutVideo === t.DEFAULT_CAPTURE.shortcutVideo)
  check("un booléen abîmé revient au défaut", bad.launchAtLogin === false)
  const good = t.sanitizeCapture({ keepDir: "C:\\Users\\me\\Pictures", shortcutImage: "Ctrl+Alt+S" })
  check("un chemin Windows est un chemin", good.keepDir === "C:\\Users\\me\\Pictures" && good.shortcutImage === "Ctrl+Alt+S")
  check("le nom d'une capture se trie", t.captureName("png", new Date(2026, 9, 3, 9, 5, 7)) === "zyvro-capture-2026-10-03-09-05-07.png")
}

// ---- 4. la réponse du serveur ---------------------------------------------------
{
  const ok = t.parsePublished({ url: "https://server.zyv.ro/content/shots/u/a.webm", gif_url: "https://server.zyv.ro/content/shots/u/a.gif?download=1", expires_at: "2026-10-04T10:00:00Z" })
  check("un lien et son GIF", ok.url.endsWith("a.webm") && ok.gifUrl.endsWith("?download=1") && ok.expiresAt !== "")
  let refused = false
  try {
    t.parsePublished({ url: "javascript:alert(1)" })
  } catch {
    refused = true
  }
  check("**un lien qui n'est pas http(s) est refusé**", refused)
  check("un GIF absent est absent", t.parsePublished({ url: "https://a/b.png", gif_url: "file:///etc/passwd" }).gifUrl === null)
}

// ---- 2. le GIF -------------------------------------------------------------------
//
// Lu comme le serveur le lit : en additionnant les délais des images.
function gifSeconds(bytes) {
  let pos = 13
  if (bytes[10] & 0x80) pos += 3 << ((bytes[10] & 7) + 1)
  let total = 0
  let delay = 0
  let frames = 0
  let transparent = 0
  const skip = () => {
    while (pos < bytes.length) {
      const n = bytes[pos++]
      if (n === 0) return
      pos += n
    }
  }
  while (pos < bytes.length) {
    const b = bytes[pos]
    if (b === 0x21) {
      const label = bytes[pos + 1]
      pos += 2
      if (label === 0xf9) {
        delay = bytes[pos + 2] | (bytes[pos + 3] << 8)
        if (bytes[pos + 1] & 1) transparent++
      }
      skip()
    } else if (b === 0x2c) {
      const flags = bytes[pos + 9]
      pos += 10
      if (flags & 0x80) pos += 3 << ((flags & 7) + 1)
      pos++
      skip()
      total += delay < 2 ? 10 : delay
      delay = 0
      frames++
    } else if (b === 0x3b) break
    else return null
  }
  return { seconds: total / 100, frames, transparent }
}

{
  const W = 64
  const H = 40
  const frame = (shade, square = null) => {
    const rgba = new Uint8Array(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = shade
      rgba[i * 4 + 1] = shade
      rgba[i * 4 + 2] = shade
      rgba[i * 4 + 3] = 255
    }
    if (square) {
      for (let y = square.y; y < square.y + 8; y++)
        for (let x = square.x; x < square.x + 8; x++) {
          rgba[(y * W + x) * 4] = 255
          rgba[(y * W + x) * 4 + 1] = 0
          rgba[(y * W + x) * 4 + 2] = 0
        }
    }
    return rgba
  }

  // Une minute, dix images par seconde, un carré qui bouge une fois sur trois.
  const clip = new t.GifClip(W, H, t.GIF_MAX_BYTES)
  let at = 0
  for (let i = 0; i < 600; i++) {
    at = i * 100
    const step = Math.floor(i / 3) % 40
    clip.add(frame(40, { x: step, y: 10 }), at)
  }
  const bytes = clip.finish(60_000)
  const read = bytes && gifSeconds(bytes)
  check("le GIF est un GIF", bytes && String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a" && bytes[bytes.length - 1] === 0x3b)
  check(
    "**il dure ce qu'a duré l'enregistrement**",
    read && Math.abs(read.seconds - 60) < 0.2,
    read ? `${read.seconds}s` : "illisible"
  )
  check("une image où rien n'a bougé ne s'écrit pas", read && read.frames === 200, read ? `${read.frames} images` : "")
  check("les images suivantes ne peignent que ce qui change", read && read.transparent === read.frames - 1)

  const still = new t.GifClip(W, H, t.GIF_MAX_BYTES)
  for (let i = 0; i < 100; i++) still.add(frame(90), i * 100)
  const stillBytes = still.finish(10_000)
  const stillRead = stillBytes && gifSeconds(stillBytes)
  check("**un écran immobile : une image, qui dure tout l'enregistrement**", stillRead && stillRead.frames === 1 && Math.abs(stillRead.seconds - 10) < 0.05)

  const heavy = new t.GifClip(W, H, 2_000)
  for (let i = 0; i < 50; i++) heavy.add(frame(i % 2 ? 20 : 230), i * 100)
  check("trop lourd : pas de GIF, et on le sait", heavy.finish(5_000) === null && heavy.tooLarge)
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLa capture ne part que d'un geste de la personne, et dit vrai sur ce qu'elle publie.")
