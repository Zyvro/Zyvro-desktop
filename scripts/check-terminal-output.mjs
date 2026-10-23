// La sortie d'un terminal : images synchronisées (DEC 2026) et cadence d'écriture.
//
// Qwen Code, claude et codex redessinent leur zone dynamique à chaque image : ils
// l'effacent ligne par ligne puis la réécrivent, en l'encadrant de `ESC[?2026h … l`.
// xterm.js 5.5 ne connaît pas ce mode et peignait l'écran à moitié effacé : tout le
// texte clignotait comme un stroboscope. Relevé sur le vrai Qwen Code 0.25 : 166
// images et plus de 5 000 effacements de ligne pour une réponse de quarante lignes ;
// rejouée dans xterm sous Chromium, la sortie laissait 14 images peintes sans la zone
// de saisie, et aucune avec `SyncOutput`.
//
// Ce qui casse en silence ici :
//
// 1. **Un repère coupé en deux** par la frontière de deux morceaux : la moitié du
//    repère s'afficherait comme du texte, ou l'image resterait ouverte.
// 2. **Une image jamais fermée** : l'agent meurt entre `h` et `l`, et l'écran resterait figé.
// 3. **Un octet perdu ou réordonné** : un terminal décale tout l'écran d'un octet.
// 4. **Une mémoire qui grossit** quand la fenêtre cachée ne vide plus rien.
//
//     node scripts/check-terminal-output.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-terminal-output-check")
mkdirSync(dir, { recursive: true })
await build({
  entryPoints: [path.join(ROOT, "src/shared/syncOutput.ts")],
  outfile: path.join(dir, "s.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  logLevel: "silent",
})
const mod = createRequire(import.meta.url)(path.join(dir, "s.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Une horloge à la main : rien ne part tant qu'on ne la fait pas tourner.
function clock() {
  const frames = []
  const timers = []
  return {
    scheduler: {
      frame: (fn) => {
        const item = { fn, live: true }
        frames.push(item)
        return () => (item.live = false)
      },
      after: (ms, fn) => {
        const item = { ms, fn, live: true }
        timers.push(item)
        return () => (item.live = false)
      },
    },
    frame: () => {
      const todo = frames.splice(0)
      for (const f of todo) if (f.live) f.fn()
    },
    elapse: (ms) => {
      const due = timers.filter((t) => t.live && t.ms <= ms)
      for (const t of due) {
        t.live = false
        t.fn()
      }
    },
    pending: () => frames.filter((f) => f.live).length,
  }
}

function make(options) {
  const c = clock()
  const out = []
  const so = new mod.SyncOutput((d) => out.push(d), c.scheduler, options)
  return { c, out, so, text: () => out.join("") }
}

const B = mod.SYNC_BEGIN
const E = mod.SYNC_END

// ---- une image se rend d'un bloc ---------------------------------------------
{
  const { c, out, so } = make()
  so.push(`avant${B}\x1b[2K\x1b[1Aligne`)
  c.frame()
  check("**ce qui précède l'image se rend, l'image ouverte attend**", out.join("") === "avant", JSON.stringify(out))
  so.push(`finale${E}après`)
  c.frame()
  check("**fermée, l'image et ce qui suit se rendent EN UNE FOIS**", out.length === 2 && out[1] === "\x1b[2K\x1b[1Aligne" + "finale" + "après", JSON.stringify(out))
  check("les repères eux-mêmes ne sont pas écrits", !out.join("").includes("2026"))
}

// ---- les repères coupés à n'importe quel octet ---------------------------------
{
  const stream = `a${B}b\x1b[2Kc${E}d${B}e${E}f\x1b[?2026$pg`
  const reference = make()
  reference.so.push(stream)
  reference.so.flushNow()
  let bad = 0
  for (let cut = 1; cut < stream.length; cut++) {
    const t = make()
    t.so.push(stream.slice(0, cut))
    t.so.push(stream.slice(cut))
    t.so.flushNow()
    if (t.text() !== reference.text()) bad++
  }
  check("**un repère coupé à n'importe quel octet donne la même sortie**", bad === 0, `${bad} coupes différentes`)
  check("**et aucun octet n'est perdu** (hors repères)", reference.text() === "ab\x1b[2Kcdef\x1b[?2026$pg", JSON.stringify(reference.text()))
  const octet = make()
  for (const ch of stream) octet.so.push(ch)
  octet.so.flushNow()
  check("un octet à la fois, même résultat", octet.text() === reference.text())
}

// ---- l'interrogation du mode n'est pas un repère -------------------------------------
{
  const t = make()
  t.so.push("x\x1b[?2026$py")
  t.so.flushNow()
  check("`ESC[?2026$p` (demande de support) passe telle quelle", t.text() === "x\x1b[?2026$py")
  const u = make()
  u.so.push("x\x1b[?2004hy")
  u.so.flushNow()
  check("un autre mode privé n'est pas touché", u.text() === "x\x1b[?2004hy")
}

// ---- une image jamais fermée -----------------------------------------------------
{
  const t = make({ holdMs: 120 })
  t.so.push(`a${B}b`)
  t.c.frame()
  check("image ouverte : rien de ce qu'elle porte n'est rendu", t.text() === "a")
  t.c.elapse(120)
  t.c.frame()
  check("**un agent qui meurt entre h et l ne fige pas l'écran** : rendu de force", t.text() === "ab", JSON.stringify(t.out))
  check("et l'image est fermée", t.so.open === false)
}

// ---- tout rendre maintenant ----------------------------------------------------------
{
  const t = make()
  t.so.push(`a${B}b`)
  t.so.flushNow()
  check("flushNow rend aussi l'image ouverte, dans l'ordre", t.text() === "ab" && !t.so.open)
}

// ---- cadence : une écriture par image d'animation ---------------------------------------
{
  const t = make()
  for (let i = 0; i < 50; i++) t.so.push(`m${i};`)
  check("le texte ordinaire n'est pas écrit morceau par morceau", t.out.length === 0 && t.c.pending() === 1)
  t.c.frame()
  check("**cinquante morceaux, une seule écriture, dans l'ordre**", t.out.length === 1 && t.out[0] === Array.from({ length: 50 }, (_, i) => `m${i};`).join(""))
}

// ---- mémoire ------------------------------------------------------------------------------
{
  const t = make({ maxBytes: 1000 })
  t.so.push("x".repeat(1500))
  check("**au-delà du plafond, on rend sans attendre l'image d'animation**", t.out.length === 1 && t.out[0].length === 1500)
  const u = make({ maxBytes: 1000 })
  u.so.push(`${B}${"y".repeat(1500)}`)
  check("une image démesurée est rendue de force", u.text().length === 1500 && !u.so.open)
}

// ---- fin de vie ---------------------------------------------------------------------------------
{
  const t = make()
  t.so.push("abc")
  t.so.dispose()
  t.c.frame()
  t.so.push("def")
  check("après dispose, rien n'est plus écrit", t.out.length === 0)
}

// ---- une vraie séance de Qwen Code ---------------------------------------------------------------
{
  // Quarante images, chacune : début, effacement de trois lignes, réécriture, fin.
  const frames = Array.from({ length: 40 }, (_, i) => `${B}\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[Gframe ${i}\r\n${E}`)
  const stream = frames.join("")
  const rendu = []
  const c = clock()
  const so = new mod.SyncOutput((d) => rendu.push(d), c.scheduler)
  // Reçu en morceaux de 7 octets : des repères coupés un peu partout.
  for (let i = 0; i < stream.length; i += 7) so.push(stream.slice(i, i + 7))
  c.frame()
  const attendu = frames.map((f) => f.slice(B.length, f.length - E.length)).join("")
  check("**quarante images reçues en morceaux de 7 octets : la même sortie, sans repères, en une écriture**", rendu.length === 1 && rendu[0] === attendu)
  // Et jamais une image à moitié : aucune écriture ne finit au milieu d'un effacement.
  check("aucune écriture ne coupe une image", rendu.every((r) => !r.endsWith("\x1b[2K") && !r.endsWith("\x1b[1A")))
}

// ---- le câblage -------------------------------------------------------------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  check("**tout ce que le shell écrit passe par SyncOutput**", /new SyncOutput\(\(data\) => \{\s*term\.write\(data, /.test(panel) && /output\.push\(payload\.data\)/.test(panel))
  const direct = [...panel.matchAll(/term\.write\(([^)]*)\)/g)].map((m) => m[1])
  check("et nulle part d'autre : seulement la bannière, l'erreur et SyncOutput", direct.every((d) => /^(data|session\.banner|`\\r\\n\\x1b\[31m)/.test(d)), direct.join(" | "))
  check("fermer le terminal vide aussi la file", /output\.dispose\(\)/.test(panel))
  // Collé en bas : un redessin d'agent qui efface aussi l'historique (ED3), ou
  // un onglet caché puis remontré, faisait tomber le défilement tout en haut.
  check("**en bas avant l'écriture, en bas après**", /if \(colle && !enBas\(\)\) term\.scrollToBottom\(\)/.test(panel))
  check("**on ne décroche du bas que par un geste (molette, barre, Maj+Page↑)**", /event\.deltaY < 0/.test(panel) && /if \(glisse\) colle = enBas\(\)/.test(panel) && /decrocher\(\)/.test(panel))
  check("**un onglet remontré revient en bas s'il y était**", /fitAddon\.fit\(\)\s*\/\/[^\n]*\n\s*recoller\(\)/.test(panel))
  const sched = readFileSync(path.join(ROOT, "src/renderer/lib/frameScheduler.ts"), "utf8")
  check("l'horloge a un filet quand la fenêtre n'anime plus", /setTimeout\(run, 50\)/.test(sched) && /requestAnimationFrame\(run\)/.test(sched))
}

console.log(failures === 0 ? "\nUne image d'agent ne se peint jamais à moitié." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
