// La passerelle qui rend claude visable.
//
// Claude Code ne poste que sur l'API Messages d'Anthropic ; nos fournisseurs
// parlent Chat Completions. Entre les deux, une traduction — et une traduction
// se trompe en silence, ce qui est la raison d'être de ce fichier.
//
// Ce qui casse sans qu'on le voie :
//
// 1. **`system` est une liste de trois blocs**, pas une chaîne. N'en garder
//    qu'un fait travailler le modèle sans le prompt de l'agent, et il répond
//    poliment à côté au lieu d'échouer.
//
// 2. **`role: "system"` arrive AU MILIEU des messages** — la bêta
//    `mid-conversation-system`. Traité comme un rôle inconnu, les rappels que
//    la CLI glisse en cours de tour disparaissent.
//
// 3. **`tool_result` voyage dans un message `user`.** Chat veut un message
//    `tool` séparé, placé juste après l'appel. Mis après le texte de
//    l'utilisateur, la requête entière est refusée.
//
// 4. **Les outils, à plat d'un côté et emboîtés de l'autre.** Anthropic écrit
//    `{name, input_schema}`, Chat écrit `{function:{name, parameters}}`.
//    Recopier l'un pour l'autre ne lève rien : le serveur ignore la liste, et
//    le modèle dit qu'il ne peut rien faire.
//
// 5. **Un bloc laissé ouvert.** Un tour Messages est fait de blocs qui
//    s'ouvrent et se ferment ; un `content_block_stop` manquant fait attendre
//    claude indéfiniment, sans message.
//
// 6. **`HEAD /api/hello` arrive sans jeton.** La CLI teste l'adresse avant de
//    s'en servir. Répondre 401 lui fait conclure que le point d'accès n'existe
//    pas, et le tour ne part jamais.
//
//     node scripts/check-messages.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-messages-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/shared/messages")}"\n` + `export { startGateway } from "${from("src/main/responses")}"\n`
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
})
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Le corps est calqué sur celui qu'un vrai claude-cli/2.1.278 envoie, relevé à
// la sonde : `system` en trois blocs, `role:"system"` au milieu, un `tool_use`
// rendu dans l'assistant et son `tool_result` dans le `user` suivant.
const CORPS = {
  model: "lmstudio/qwen3-coder-next",
  max_tokens: 32000,
  stream: true,
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.278" },
    { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "Zyvro preamble." },
  ],
  thinking: { type: "adaptive", display: "omitted" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
  metadata: { user_id: "{}" },
  tools: [
    {
      name: "Bash",
      description: "Run a command",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  ],
  tool_choice: { type: "any" },
  messages: [
    { role: "user", content: [{ type: "text", text: "lis marqueur.txt" }] },
    { role: "system", content: [{ type: "text", text: "rappel de milieu de tour" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat marqueur.txt" }, cache_control: { type: "ephemeral" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "marqueur-secret", is_error: false },
        { type: "text", text: "et ensuite ?" },
      ],
    },
  ],
}

// ---- la requête ---------------------------------------------------------
{
  const messages = mod.messagesFrom(CORPS)
  const roles = messages.map((m) => m.role).join(",")

  check(
    "**les trois blocs `system` deviennent un seul message système**",
    messages[0].role === "system" && messages[0].content.includes("Claude Code") && messages[0].content.includes("Zyvro preamble"),
    messages[0]?.content
  )
  check("**un `system` de milieu de tour reste un système**", roles === "system,user,system,assistant,tool,user", roles)

  const appel = messages.find((m) => m.tool_calls)
  check("un `tool_use` redevient un appel d'outil", appel?.tool_calls?.[0]?.function?.name === "Bash", JSON.stringify(appel))
  check("et il porte ses arguments en JSON", appel.tool_calls[0].function.arguments === '{"command":"cat marqueur.txt"}')
  check("avec l'identifiant que le résultat citera", appel.tool_calls[0].id === "toolu_1")

  const resultat = messages.find((m) => m.role === "tool")
  check("**le résultat d'outil retrouve l'appel qu'il répond**", resultat.tool_call_id === "toolu_1", JSON.stringify(resultat))
  check("et son contenu est du texte", resultat.content === "marqueur-secret")
  check(
    "**et il passe AVANT le texte de l'utilisateur qui le portait**",
    messages.indexOf(resultat) < messages.findIndex((m) => m.content === "et ensuite ?"),
    roles
  )

  check(
    "**ce qu'aucun serveur Chat ne sait lire n'est pas renvoyé**",
    !JSON.stringify(messages).includes("cache_control") && !JSON.stringify(messages).includes("clear_thinking"),
    "le marqueur de cache et le réglage de raisonnement d'Anthropic"
  )

  const outils = mod.toolsFrom(CORPS)
  check("**un outil passe de plat à emboîté**", outils.length === 1 && outils[0].function.name === "Bash", JSON.stringify(outils))
  check("et `input_schema` devient `parameters`", outils[0].function.parameters.properties.command.type === "string")

  const chat = mod.chatRequestFrom(CORPS, "qwen3-coder-next")
  check("**le modèle envoyé est celui du fournisseur, pas la route**", chat.model === "qwen3-coder-next")
  check("**et le flux porte son compte de jetons**", chat.stream_options?.include_usage === true)
  check("**`max_tokens` traverse**", chat.max_tokens === 32000, "sinon le défaut du serveur coupe l'agent au milieu d'une phrase")
  check("`any` devient `required`", chat.tool_choice === "required", JSON.stringify(chat.tool_choice))
}

// ---- une image ----------------------------------------------------------
{
  const messages = mod.messagesFrom({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "que vois-tu ?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
        ],
      },
    ],
  })
  const parts = messages[0].content
  check("**une image en base64 devient une URL `data:`**", parts[1]?.image_url?.url === "data:image/png;base64,AAAB", JSON.stringify(parts))
  check("et le texte reste à côté d'elle", parts[0]?.text === "que vois-tu ?")
}

// ---- le flux de retour --------------------------------------------------
{
  const t = new mod.Translator("lmstudio/qwen3-coder-next", "test")
  const debut = t.created()
  check("**le tour s'ouvre par `message_start`**", debut.type === "message_start" && debut.message.role === "assistant")

  const rendu = [
    ...t.push({ choices: [{ delta: { content: "BON" } }] }),
    ...t.push({ choices: [{ delta: { content: "JOUR" } }] }),
    ...t.push({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
    ...t.end(),
  ]
  const types = rendu.map((e) => e.type).join(",")
  check(
    "**un bloc de texte s'ouvre, coule et se ferme**",
    types === "content_block_start,content_block_delta,content_block_delta,content_block_stop,message_delta,message_stop",
    types
  )
  check(
    "le texte est recollé dans l'ordre",
    rendu.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("") === "BONJOUR"
  )
  const fin = rendu.find((e) => e.type === "message_delta")
  check("**et les jetons arrivent avec**", fin.usage.input_tokens === 11 && fin.usage.output_tokens === 3, JSON.stringify(fin.usage))
  check("un tour qui s'arrête tout seul dit `end_turn`", fin.delta.stop_reason === "end_turn")
}

// ---- un appel d'outil, qui arrive par morceaux ---------------------------
{
  const t = new mod.Translator("route", "test")
  const rendu = [
    ...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Bash", arguments: '{"com' } }] } }] }),
    ...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] }),
    ...t.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ...t.end(),
  ]
  const debut = rendu.find((e) => e.type === "content_block_start")
  check("**un appel d'outil ouvre un bloc `tool_use`**", debut?.content_block?.type === "tool_use", JSON.stringify(debut))
  check("qui garde l'identifiant que claude devra citer", debut.content_block.id === "call_9")
  check("et le nom, qui n'est que dans le premier morceau", debut.content_block.name === "Bash")
  check(
    "**les morceaux d'arguments se recollent dans l'ordre**",
    rendu.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("") === '{"command":"ls"}'
  )
  check("**le bloc est refermé**", rendu.some((e) => e.type === "content_block_stop"), "sinon claude attend sans rien dire")
  check(
    "**et la fin dit `tool_use`, pas `end_turn`**",
    rendu.find((e) => e.type === "message_delta").delta.stop_reason === "tool_use",
    "sinon claude rend une réponse vide pour un tour où le modèle demandait un outil"
  )
}

// ---- du texte PUIS un outil ---------------------------------------------
{
  const t = new mod.Translator("route", "test")
  const rendu = [
    ...t.push({ choices: [{ delta: { content: "je regarde" } }] }),
    ...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Bash", arguments: "{}" } }] } }] }),
    ...t.end(),
  ]
  const indices = rendu.filter((e) => e.type === "content_block_start").map((e) => e.index)
  check("**deux blocs, numérotés à la suite**", JSON.stringify(indices) === "[0,1]", JSON.stringify(indices))
  check(
    "**le bloc de texte est fermé avant que l'autre s'ouvre**",
    rendu.findIndex((e) => e.type === "content_block_stop") < rendu.findIndex((e) => e.index === 1),
    rendu.map((e) => `${e.type}:${e.index ?? ""}`).join(",")
  )
}

// ---- la passerelle, en vrai ---------------------------------------------
{
  // Un faux serveur Chat, qui répond un tour complet en flux.
  const amont = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`)
    send({ choices: [{ delta: { content: "bonjour" } }] })
    send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })
    res.write("data: [DONE]\n\n")
    res.end()
  })
  await new Promise((r) => amont.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${amont.address().port}/v1`

  const gateway = await mod.startGateway()
  gateway.aim("lmstudio/qwen3-coder-next", { provider: "lmstudio", url, key: "", model: "qwen3-coder-next" })

  check("**l'adresse de claude est sans `/v1`**", gateway.origin.endsWith(gateway.origin.split("/").pop()) && !gateway.origin.endsWith("/v1"), gateway.origin)

  // `HEAD /api/hello`, sans jeton : c'est ce que la CLI envoie avant tout.
  const hello = await fetch(`${gateway.origin}/api/hello`, { method: "HEAD" })
  check("**`HEAD /api/hello` répond 200 sans jeton**", hello.status === 200, String(hello.status))

  const sansJeton = await fetch(`${gateway.origin}/v1/messages`, { method: "POST", body: "{}" })
  check("**sans le jeton, la passerelle ne relaie rien**", sansJeton.status === 401, String(sansJeton.status))

  const entetes = { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }
  const inconnu = await fetch(`${gateway.origin}/v1/messages`, {
    method: "POST",
    headers: entetes,
    body: JSON.stringify({ model: "pas-ce-modele", messages: [] }),
  })
  check("**un modèle qu'elle ne sert pas est nommé, pas deviné**", inconnu.status === 404)
  check("et elle dit ce qu'elle sert", (await inconnu.json()).error.message.includes("lmstudio/qwen3-coder-next"))

  const reponse = await fetch(`${gateway.origin}/v1/messages?beta=true`, {
    method: "POST",
    headers: entetes,
    body: JSON.stringify({ ...CORPS, messages: [{ role: "user", content: "salut" }] }),
  })
  const flux = await reponse.text()
  check("**un tour entier traverse**", reponse.status === 200 && flux.includes("message_stop"), flux.slice(0, 200))
  check("en portant le texte du modèle", flux.includes("bonjour"))
  check("**et chaque événement est nommé sur le fil**", flux.includes("event: message_start\ndata: "), flux.slice(0, 120))

  gateway.close()
  amont.close()
}

console.log(
  failures === 0
    ? "\nclaude peut viser les serveurs de ce projet, et la traduction ne perd rien en chemin."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
