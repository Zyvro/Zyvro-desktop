// Une image produite par le moteur s'affichait sur `http://127.0.0.1:0/…`.
//
// Le desktop n'apprend le port de son moteur qu'au démarrage, alors que le code
// partagé lit son origine une fois pour toutes dans une constante. La parade
// existait — une fonction `mediaSrc` dans `lib/daemon.ts` qui remplaçait le
// port. Elle n'avait aucun appelant : tous les composants passaient par
// `mediaUrl`, celle du front, celle qui rend le port 0. Deux fonctions pour une
// question, donc une des deux se trompait, et c'était toujours la même.
//
// Rien n'avait l'air faux en lisant le code : le correctif était là, sous les
// yeux, simplement ce n'était pas lui qui tournait. Ce script vérifie que
// l'unique fonction restante donne bien la bonne adresse une fois le moteur
// attaché — et qu'elle la donne aussi après un changement de projet, parce que
// le port change alors.
//
//     node scripts/check-media-url.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const FRONT = path.resolve(ROOT, "../Zyvro-frontend/src")
const dir = path.join(ROOT, "node_modules", ".zyvro-media-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { mediaUrl } from "@/lib/api"\n` +
    `export { attachDaemon, detachDaemon, installDaemonFetch } from "${path
      .join(ROOT, "src/renderer/lib/daemon")
      .replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  absWorkingDir: ROOT,
  logLevel: "silent",
  alias: { "@": FRONT },
  // La même substitution que le vrai build : c'est elle qui grave le
  // marqueur que tout ceci doit remplacer.
  define: { "process.env.NEXT_PUBLIC_API_URL": JSON.stringify("http://127.0.0.1:0") },
})

globalThis.window ??= { fetch: async () => new Response("") }
const { mediaUrl, attachDaemon, detachDaemon, installDaemonFetch } = createRequire(import.meta.url)(
  path.join(dir, "h.cjs")
)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

installDaemonFetch()

attachDaemon("http://127.0.0.1:54321", "jeton")
const resolved = mediaUrl("/content/run-node-image.png")
check("une image du moteur vise le port du moteur", resolved === "http://127.0.0.1:54321/content/run-node-image.png", resolved)
check("le port 0 a disparu", !resolved.includes(":0/"), resolved)

// Un projet peut être fermé puis un autre ouvert : le port change, et une
// origine capturée une fois resterait celle d'un moteur qui n'écoute plus.
attachDaemon("http://127.0.0.1:60000", "jeton")
check("un changement de projet suit le nouveau port", mediaUrl("/content/x.png") === "http://127.0.0.1:60000/content/x.png")

check("une data URL est laissée telle quelle", mediaUrl("data:image/png;base64,AAAA") === "data:image/png;base64,AAAA")
check("une adresse déjà complète est laissée telle quelle", mediaUrl("https://zyv.ro/a.png") === "https://zyv.ro/a.png")

detachDaemon()
check(
  "sans moteur, l'adresse n'invente pas un hôte",
  mediaUrl("/content/x.png") === "http://127.0.0.1:0/content/x.png",
  mediaUrl("/content/x.png")
)

console.log(failures === 0 ? "\nUne seule fonction dit où sont les images." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
