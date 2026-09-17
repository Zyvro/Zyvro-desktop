// L'outil de capture, exercé pour de vrai : on monte le module, on lui donne
// de fausses fenêtres, et on lui parle en JSON-RPC comme le ferait un agent.
//
// Ce qui casse en silence ici :
//
// 1. Le jeton. Le serveur écoute sur la boucle locale, mais tout processus de
//    la machine peut y frapper. Sans vérification, n'importe quel programme
//    obtient une photo de la fenêtre de quelqu'un.
//
// 2. Le choix de la fenêtre. L'app en ouvre une par projet. Une capture qui
//    rend toujours la première rendrait le mauvais projet sans jamais le dire,
//    et l'image aurait l'air normale.
//
// 3. Une erreur d'outil doit revenir dans le résultat, pas en code HTTP : un
//    client MCP montre le contenu au modèle, alors qu'un 500 ne lui apprend
//    rien.
//
//     node scripts/check-shots.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-shots-check")
mkdirSync(dir, { recursive: true })

// Une fausse fenêtre : elle rend un PNG minuscule mais valide, et retient la
// région qu'on lui a demandée pour qu'on puisse vérifier qu'elle est passée.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: {}, BrowserWindow: {} }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/main/shots").replace(/\\/g, "/")}"\n` +
    `export { claudeMcpConfig } from "${path.join(ROOT, "src/main/agent").replace(/\\/g, "/")}"\n`
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
const shots = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

function fakeWindow({ id, title, focused = false, destroyed = false }) {
  const asked = {}
  return {
    id,
    asked,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isVisible: () => true,
    getTitle: () => title,
    getSize: () => [1280, 800],
    webContents: {
      capturePage: async (rect) => {
        asked.rect = rect
        return {
          getSize: () => ({ width: 1280, height: 800 }),
          resize: ({ width, height }) => ({
            getSize: () => ({ width, height }),
            toPNG: () => Buffer.from(PNG_1x1, "base64"),
            resize() {
              return this
            },
          }),
          toPNG: () => Buffer.from(PNG_1x1, "base64"),
        }
      },
    },
  }
}

// ---- le choix de la fenêtre --------------------------------------------
{
  const a = fakeWindow({ id: 1, title: "projet-a" })
  const b = fakeWindow({ id: 2, title: "projet-b", focused: true })
  const gone = fakeWindow({ id: 3, title: "fermée", destroyed: true })
  check("sans indication, c'est la fenêtre au premier plan", shots.pickWindow([a, b, gone])?.id === 2)
  check("**une fenêtre nommée est celle qu'on obtient**", shots.pickWindow([a, b], 1)?.id === 1)
  check("une fenêtre détruite n'est jamais choisie", shots.pickWindow([gone])?.id === undefined)
  check("un identifiant inconnu ne se rabat pas sur une autre", shots.pickWindow([a, b], 99) === undefined)
  const listed = shots.describeWindows([a, b, gone])
  check("la liste ne montre que ce qui est ouvert", listed.length === 2 && listed.every((w) => w.title !== "fermée"))
  check("elle donne de quoi en nommer une", listed[0].id === 1 && typeof listed[0].width === "number")
}

// ---- les arguments ------------------------------------------------------
check("une échelle absurde est ramenée dans les clous", shots.clampScale(0) === 0.1 && shots.clampScale(99) === 2)
check("une échelle absente vaut un", shots.clampScale(undefined) === 1)
check("une région négative est refusée plutôt que corrigée", shots.cleanRect({ x: 0, y: 0, width: -5, height: 10 }) === undefined)
check("une région valide passe en entiers", JSON.stringify(shots.cleanRect({ x: 1.6, y: 2, width: 10, height: 10 })) === '{"x":2,"y":2,"width":10,"height":10}')

// ---- le serveur ---------------------------------------------------------
const windows = [fakeWindow({ id: 1, title: "projet-a", focused: true }), fakeWindow({ id: 2, title: "projet-b" })]
const handle = await shots.startShotsServer(() => windows)
check("le serveur écoute sur la boucle locale", handle.origin.startsWith("http://127.0.0.1:"), handle.origin)

const call = async (body, token = handle.token) =>
  fetch(handle.origin, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

{
  const res = await call({ id: 1, method: "tools/list" }, "mauvais-jeton")
  check("**sans le bon jeton, rien**", res.status === 401, String(res.status))
}
{
  const res = await call({ id: 2, method: "tools/list" })
  const body = await res.json()
  const names = body.result.tools.map((t) => t.name)
  check("les deux outils sont annoncés", names.includes("zyvro_screenshot") && names.includes("zyvro_list_windows"), names.join(", "))
  const shot = body.result.tools.find((t) => t.name === "zyvro_screenshot")
  check("la capture se déclare sans effet de bord", shot.annotations.readOnlyHint === true)
  check("et fermée sur le monde extérieur", shot.annotations.openWorldHint === false)
}
{
  const res = await call({ id: 3, method: "tools/call", params: { name: "zyvro_screenshot", arguments: {} } })
  const body = await res.json()
  check("une capture revient en image", body.result.content[0].type === "image" && body.result.content[0].mimeType === "image/png")
}
{
  const out = path.join(tmpdir(), "zyvro-shot-check", "a.png")
  rmSync(path.dirname(out), { recursive: true, force: true })
  const res = await call({
    id: 4,
    method: "tools/call",
    params: { name: "zyvro_screenshot", arguments: { window: 2, path: out, rect: { x: 5, y: 5, width: 100, height: 50 } } },
  })
  const body = await res.json()
  check("un chemin donné écrit le fichier", readFileSync(out).length > 0)
  check("le dossier manquant est créé", body.result.content[0].text.includes(out))
  check("**la région demandée atteint la fenêtre**", JSON.stringify(windows[1].asked.rect) === '{"x":5,"y":5,"width":100,"height":50}', JSON.stringify(windows[1].asked.rect))
  check("et c'est bien la fenêtre nommée qui a été photographiée", windows[0].asked.rect === undefined)
}
{
  const res = await call({ id: 5, method: "tools/call", params: { name: "zyvro_screenshot", arguments: { window: 42 } } })
  const body = await res.json()
  check("**une erreur d'outil revient au modèle, pas en code HTTP**", res.status === 200 && body.result.isError === true, String(res.status))
  check("et elle dit quelles fenêtres existent", body.result.content[0].text.includes("projet-a"), body.result.content[0].text)
}
{
  const res = await call({ id: 6, method: "tools/call", params: { name: "zyvro_inventé" } })
  const body = await res.json()
  check("un outil inconnu est refusé", body.result.isError === true)
}

// ---- ce que l'agent reçoit ---------------------------------------------
//
// C'est le point de tout ceci : l'outil n'existe que si la configuration écrite
// pour le tour le nomme. Un serveur qui écoute et que personne ne déclare est
// un serveur que l'agent n'a pas.
{
  const cfg = shots.claudeMcpConfig({ daemonOrigin: "http://127.0.0.1:4000", daemonToken: "jeton-moteur" })
  const written = JSON.parse(readFileSync(cfg.path, "utf8"))
  const names = Object.keys(written.mcpServers)
  check("**la configuration de l'agent nomme les deux serveurs**", names.includes("zyvro") && names.includes("zyvro-app"), names.join(", "))
  check("la capture y porte son jeton à elle", written.mcpServers["zyvro-app"].headers.Authorization === `Bearer ${handle.token}`)
  check("et son adresse à elle", written.mcpServers["zyvro-app"].url === handle.origin)
  check("le moteur garde le sien", written.mcpServers.zyvro.headers.Authorization === "Bearer jeton-moteur")
  cfg.dispose()
}

handle.close()
console.log(failures === 0 ? "\nL'agent peut photographier l'app, et seulement l'app." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
