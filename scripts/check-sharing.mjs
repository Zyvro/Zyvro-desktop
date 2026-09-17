// Partager un workflow, et retrouver les siens.
//
// Deux choses s'y jouent qui ne font pas de bruit quand elles sont fausses.
//
// La visibilité. Partager avec un ami n'est pas publier dans un catalogue, et
// les deux sont à un mot l'un de l'autre dans cette API : `unlisted` veut dire
// « accessible par le lien, listé nulle part », `public` veut dire « dans la
// vitrine ». Se tromper ne lève aucune erreur — ça met le travail de quelqu'un
// en devanture.
//
// L'origine du lien. L'API répond sur `server.zyv.ro`, les pages sont servies
// par `zyv.ro`. Un lien qui pointerait sur l'API donnerait à l'ami une page de
// JSON.
//
//     node scripts/check-sharing.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-sharing-check")
mkdirSync(dir, { recursive: true })

// Le module principal ne sert ici qu'à dire où l'on parle ; electron et le
// réseau sont remplacés pour que le test regarde la requête au lieu de
// l'envoyer.
// JSON.stringify et pas des guillemets : sous Windows ce chemin contient des
// antislashs, et collé tel quel dans une chaîne JS il devient une suite
// d'échappements. Le dossier rendu par getPath n'était alors pas celui où le
// test dépose la session, et le partage répondait « Sign in to publish » — sur
// Windows seulement, donc invisible depuis un Mac.
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(dir)} } }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { webOrigin, storeOrigin } from "${path.join(ROOT, "src/main/account").replace(/\\/g, "/")}"\n` +
    `export { share, mine } from "${path.join(ROOT, "src/main/sharing").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT, logLevel: "silent",
})

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const load = (env) => {
  for (const key of ["ZYVRO_STORE_ORIGIN", "ZYVRO_WEB_ORIGIN"]) delete process.env[key]
  Object.assign(process.env, env)
  const req = createRequire(import.meta.url)
  delete req.cache[path.join(dir, "h.cjs")]
  return req(path.join(dir, "h.cjs"))
}

// ---- où mène le lien ----------------------------------------------------
let m = load({})
check("par défaut, le lien vise le site et non l'API", m.webOrigin() === "https://zyv.ro", m.webOrigin())
check("et l'API reste l'API", m.storeOrigin() === "https://server.zyv.ro")

m = load({ ZYVRO_STORE_ORIGIN: "https://server.exemple.test" })
check("un autre déploiement suit la même convention", m.webOrigin() === "https://exemple.test", m.webOrigin())

m = load({ ZYVRO_STORE_ORIGIN: "http://127.0.0.1:4102" })
check("une adresse locale n'est pas charcutée", m.webOrigin() === "http://127.0.0.1:4102", m.webOrigin())

m = load({ ZYVRO_STORE_ORIGIN: "https://api.ailleurs.test" })
check("un hôte qui ne suit pas la convention est laissé tel quel", m.webOrigin() === "https://api.ailleurs.test", m.webOrigin())

m = load({ ZYVRO_STORE_ORIGIN: "https://server.zyv.ro", ZYVRO_WEB_ORIGIN: "https://autre.test/" })
check("un réglage explicite l'emporte", m.webOrigin() === "https://autre.test", m.webOrigin())

// ---- ce qui part vraiment ----------------------------------------------
m = load({ ZYVRO_STORE_ORIGIN: "https://server.zyv.ro" })
let sent = null
globalThis.fetch = async (url, init) => {
  sent = { url: String(url), method: init?.method, body: JSON.parse(init?.body ?? "{}") }
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: "abc123", name: "Photos" }) }
}
// authorized() exige une clé stockée ; on en dépose une dans le dossier factice.
writeFileSync(
  path.join(dir, "account.json"),
  JSON.stringify({ origin: "https://server.zyv.ro", key: "k", account: { id: "u", email: "e", name: "n" } })
)

const shared = await m.share({ name: "Photos", description: "d", graph: { nodes: [], edges: [] } })
check("le partage poste sur les workflows du compte", sent?.url.endsWith("/api/workflows") && sent.method === "POST", JSON.stringify(sent?.url))
check("**en unlisted, jamais en public**", sent?.body.visibility === "unlisted", String(sent?.body.visibility))
check("le graphe part comme graphe et non comme texte", typeof sent?.body.graph_json === "object")
check("le lien pointe sur la page, avec l'identifiant rendu", shared.url === "https://zyv.ro/w/abc123", shared.url)

// Un serveur qui accepte sans dire où : mieux vaut le dire que rendre un lien
// qui mène nulle part.
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({}) })
let refused = ""
try { await m.share({ name: "x", description: "", graph: {} }) } catch (error) { refused = error.message }
check("un serveur muet ne produit pas un lien mort", /did not say where it went/.test(refused), refused)

// ---- la liste -----------------------------------------------------------
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify([{ id: "1", name: "A" }]) })
check("mes workflows se lisent comme une liste", (await m.mine()).length === 1)
globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ oops: true }) })
check("une réponse qui n'est pas une liste ne casse pas le panneau", (await m.mine()).length === 0)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nUn partage est un lien privé, et il mène à une page." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
