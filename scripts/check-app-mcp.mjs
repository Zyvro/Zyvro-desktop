// Le serveur MCP de l'application, éprouvé en lui parlant.
//
// Il y a deux serveurs MCP dans Zyvro : le démon du projet, écrit en Go, et
// celui de l'application, écrit ici — c'est lui qui sert la capture d'écran, le
// navigateur d'essai et l'outil par lequel un agent demande une permission. Un
// démon ne peut pas photographier une fenêtre Electron.
//
// Deux implémentations du même protocole, donc deux façons de s'en écarter. Et
// s'en écarter ne produit pas d'erreur : le client de claude s'accommodait de
// tout ce qui suit, donc rien ne se voyait. Le client de Qwen Code, plus strict,
// se déconnectait — et le seul signe était une ligne au milieu de sa sortie :
//
//   Warning: MCP server(s) failed to start: zyvro-app.
//   Continuing with built-in tools and any servers that did connect.
//
// Continuing, justement. Le tour se déroulait, l'agent répondait, et il n'avait
// ni capture d'écran, ni navigateur, ni permission à demander.
//
// Les trois écarts, dans l'ordre où ils ont été trouvés :
//
// 1. **La version du protocole** était `2024-11-05` en dur, quelle que soit la
//    demande. Le moteur, lui, répond celle du client quand il la parle.
// 2. **Un GET répondait 404.** La spécification dit 405 quand il n'y a pas de
//    flux d'événements : 404 veut dire « cette adresse n'existe pas ».
// 3. **Une méthode inconnue répondait `404 {"error":"unknown method …"}`**, une
//    erreur de transport au lieu d'une erreur JSON-RPC. C'était la vraie cause :
//    après s'être connecté, le client de Qwen Code demande `prompts/list` puis
//    `resources/list`, que ce serveur ne sert pas, et prenait le 404 pour la
//    preuve qu'il n'y avait pas de serveur.
//
// Ce garde démarre le vrai serveur et lui parle, plutôt que de relire le code :
// ce qui compte ici est ce qui sort sur le fil.
//
//     node scripts/check-app-mcp.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-appmcp-check")
mkdirSync(dir, { recursive: true })
writeFileSync(
  path.join(dir, "h.ts"),
  `export { startShotsServer } from "${path.join(ROOT, "src/main/shots").replace(/\\/g, "/")}"\n` +
    `export { MCP_PROTOCOL_VERSIONS, negotiateProtocol } from "${path.join(ROOT, "src/shared/mcpversion").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { startShotsServer, MCP_PROTOCOL_VERSIONS, negotiateProtocol } = createRequire(import.meta.url)(
  path.join(dir, "h.cjs")
)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const serveur = await startShotsServer(() => [], undefined, async () => ({ allow: true }))
const parler = async (corps, methode = "POST") => {
  const res = await fetch(`${serveur.origin}/mcp`, {
    method: methode,
    headers: {
      Authorization: `Bearer ${serveur.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: methode === "POST" ? JSON.stringify(corps) : undefined,
  })
  const texte = await res.text()
  let json = null
  try { json = JSON.parse(texte) } catch { /* pas du JSON, c'est une réponse en soi */ }
  return { status: res.status, json, texte }
}

// ---- la version du protocole se négocie ----------------------------------
{
  const demandee = MCP_PROTOCOL_VERSIONS[0]
  const r = await parler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: demandee } })
  check("**la version demandée est celle qu'on rend**", r.json?.result?.protocolVersion === demandee, JSON.stringify(r.json?.result))
  // Les autres versions qu'on parle aussi.
  for (const v of MCP_PROTOCOL_VERSIONS.slice(1)) {
    const autre = await parler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } })
    check(`et ${v} aussi`, autre.json?.result?.protocolVersion === v)
  }
  // Une version qu'on ne parle pas : on répond la plus récente, et c'est au
  // client de décider s'il continue — pas un refus.
  const inconnue = await parler({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })
  check(
    "**une version inconnue reçoit la plus récente, pas un refus**",
    inconnue.status === 200 && inconnue.json?.result?.protocolVersion === MCP_PROTOCOL_VERSIONS[0]
  )
  check("et la fonction dit la même chose", negotiateProtocol("1999-01-01") === MCP_PROTOCOL_VERSIONS[0])
}

// ---- une méthode qu'on ne sert pas ---------------------------------------
{
  // La vraie cause. Le client demande ces deux-là juste après s'être connecté.
  for (const methode of ["prompts/list", "resources/list", "une/methode/inventee"]) {
    const r = await parler({ jsonrpc: "2.0", id: 7, method: methode })
    check(`**${methode} : 200 et une erreur JSON-RPC**`, r.status === 200, `status ${r.status}`)
    check(`  code -32601`, r.json?.error?.code === -32601, JSON.stringify(r.json))
    check(`  et l'identifiant est rendu`, r.json?.id === 7, JSON.stringify(r.json?.id))
    // Un corps qui n'est pas du JSON-RPC est lu comme une panne de transport.
    check(`  pas de \`{"error": "…"}\` nu`, r.json?.error?.code !== undefined && !("error" in (r.json ?? {}) && typeof r.json.error === "string"))
  }
}

// ---- ce qu'on sert, on le sert -------------------------------------------
{
  const outils = await parler({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  check("**les outils s'annoncent**", Array.isArray(outils.json?.result?.tools) && outils.json.result.tools.length > 0)
  const noms = outils.json.result.tools.map((t) => t.name)
  check("dont la capture d'écran", noms.includes("zyvro_screenshot"))
  check("et la demande de permission", noms.includes("zyvro_permission"))

  const initialise = await parler({ jsonrpc: "2.0", method: "notifications/initialized" })
  check("une notification est acquittée sans corps", initialise.status === 202)
}

// ---- un GET n'est pas une adresse qui n'existe pas ------------------------
{
  const r = await parler(null, "GET")
  check(
    "**un GET répond 405, pas 404**",
    r.status === 405,
    `status ${r.status} : 404 veut dire « cette adresse n'existe pas »`
  )
}

// ---- et rien de tout ça sans le jeton ------------------------------------
{
  const res = await fetch(`${serveur.origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  check("**sans jeton, rien**", res.status === 401, `status ${res.status}`)
}

// ---- la liste des versions a un jumeau, en Go ----------------------------
{
  // Deux langages, deux serveurs, une seule vérité : un client qui parle à l'un
  // et à l'autre doit obtenir la même réponse.
  const go = readFileSync(path.join(ROOT, "../Zyvro-engine/mcp/protocol.go"), "utf8")
  const ligne = /var ProtocolVersions = \[\]string\{([^}]*)\}/.exec(go)
  const duMoteur = ligne ? [...ligne[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
  check(
    "**la même liste de versions que le moteur**",
    JSON.stringify(duMoteur) === JSON.stringify([...MCP_PROTOCOL_VERSIONS]),
    `moteur ${JSON.stringify(duMoteur)} · application ${JSON.stringify([...MCP_PROTOCOL_VERSIONS])}`
  )
}

await serveur.close?.()
console.log(
  failures === 0
    ? "\nLe serveur MCP de l'application répond comme celui du moteur, et un client strict s'y connecte."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
