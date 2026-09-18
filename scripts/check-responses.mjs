// La passerelle qui rend codex visable.
//
// codex 0.152.0 ne poste que sur l'API Responses d'OpenAI ; nos fournisseurs
// parlent Chat Completions. Entre les deux, une traduction — et une traduction
// se trompe en silence, ce qui est la raison d'être de ce fichier.
//
// Ce qui casse sans qu'on le voie :
//
// 1. **Une erreur amont avalée.** LM Studio refuse pour cause de contexte trop
//    court, et il le dit DANS un flux à 200, sous la forme `{"error":{…}}`.
//    Sans traitement, le tour se termine « réussi » avec zéro caractère : codex
//    affiche un tour vide et personne ne sait pourquoi. Vu en vrai avant d'être
//    corrigé, et c'est le pire des deux silences.
//
// 2. **Les outils, à plat d'un côté et emboîtés de l'autre.** Responses écrit
//    `{type:"function", name, parameters}`, Chat écrit
//    `{type:"function", function:{name, parameters}}`. Recopier l'un pour
//    l'autre ne lève rien : le serveur ignore la liste, et le modèle répond
//    poliment qu'il ne peut rien faire.
//
// 3. **Le compte des jetons.** Un flux Chat ne porte aucun `usage` sans
//    `stream_options: {include_usage: true}`. Mesuré : « tokens used 0 » avant,
//    19 790 après, sur le même tour.
//
// 4. **Le rôle `developer`.** C'est le rôle système de Responses ; le laisser
//    passer tel quel fait jeter par le serveur le bloc qui décrit les
//    compétences et le bac à sable.
//
// 5. **Un appel d'outil arrive par morceaux.** Le nom et l'identifiant ne sont
//    dans que le premier ; les suivants ne portent que des bouts d'arguments,
//    et les recoller à l'envers donne du JSON invalide que codex ne peut pas
//    exécuter.
//
//     node scripts/check-responses.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-responses-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/shared/responses")}"\n` + `export { startGateway } from "${from("src/main/responses")}"\n`
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

// Le corps que codex envoie vraiment, réduit à ce qui compte. Relevé en le
// faisant parler à un serveur qui écrit ce qu'il reçoit, pas écrit de mémoire.
const REQUETE = {
  model: "lmstudio/qwen3-coder-next",
  instructions: "You are a coding agent running in the Codex CLI.",
  input: [
    { type: "message", id: "m1", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>…" }] },
    { type: "message", id: "m2", role: "user", content: [{ type: "input_text", text: "lis marqueur.txt" }] },
    { type: "reasoning", id: "r1", encrypted_content: "opaque" },
    { type: "function_call", id: "fc1", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"cat marqueur.txt"}' },
    { type: "function_call_output", call_id: "call_1", output: "marqueur-secret" },
  ],
  tools: [
    { type: "function", name: "exec_command", description: "Runs a command.", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
    { type: "namespace", name: "multi_agent_v1" },
    { type: "web_search" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high", summary: "auto" },
  include: ["reasoning.encrypted_content"],
  store: false,
  stream: true,
}

// ---- la requête, traduite ------------------------------------------------
{
  const messages = mod.messagesFrom(REQUETE)
  const roles = messages.map((m) => m.role).join(",")
  check("**les instructions deviennent le message système**", messages[0].role === "system" && messages[0].content.startsWith("You are a coding agent"))
  check("**`developer` est un rôle système, pas un rôle inconnu**", roles === "system,system,user,assistant,tool", roles)

  const appel = messages.find((m) => m.role === "assistant")
  check("un appel d'outil passé redevient un message d'assistant", appel.tool_calls?.[0]?.function?.name === "exec_command")
  check("et il porte ses arguments", appel.tool_calls[0].function.arguments === '{"cmd":"cat marqueur.txt"}')

  const resultat = messages.find((m) => m.role === "tool")
  check("**le résultat d'outil retrouve l'appel qu'il répond**", resultat.tool_call_id === "call_1", JSON.stringify(resultat))
  check("et son contenu est du texte", resultat.content === "marqueur-secret")

  // Les jetons de raisonnement chiffrés du modèle d'OpenAI : personne d'autre ne
  // sait les relire, et les renvoyer gonfle le contexte d'un opaque qu'on jette.
  check("**le raisonnement chiffré n'est pas renvoyé à un autre serveur**", !JSON.stringify(messages).includes("opaque"))

  const outils = mod.toolsFrom(REQUETE)
  check("**un outil passe de plat à emboîté**", outils.length === 1 && outils[0].function.name === "exec_command", JSON.stringify(outils))
  check("et son schéma le suit", outils[0].function.parameters.properties.cmd.type === "string")
  // Traduire un outil qu'aucun serveur ne peut exécuter ferait croire au modèle
  // qu'il peut appeler quelque chose qui n'arrivera nulle part.
  check("**ce qu'aucun serveur Chat ne sait faire n'est pas promis**", !JSON.stringify(outils).includes("web_search") && !JSON.stringify(outils).includes("namespace"))

  const chat = mod.chatRequestFrom(REQUETE, "qwen3-coder-next")
  check("**le modèle envoyé est celui du fournisseur, pas la route**", chat.model === "qwen3-coder-next")
  check("**et le flux porte son compte de jetons**", chat.stream_options?.include_usage === true, "« tokens used 0 » pour un tour qui a coûté")
  check("le choix d'outil est repris", chat.tool_choice === "auto")
}

// ---- le flux de retour, traduit ------------------------------------------
{
  const t = new mod.Translator("lmstudio/qwen3-coder-next", "essai")
  const vus = [t.created()]
  for (const morceau of ["BON", "JOUR"]) {
    vus.push(...t.push({ choices: [{ delta: { content: morceau } }] }))
  }
  vus.push(...t.push({ usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }))
  vus.push(...t.end())
  const types = vus.map((e) => e.type)

  check(
    "**un tour de texte a la forme que codex attend**",
    types.join(" ") ===
      "response.created response.output_item.added response.content_part.added response.output_text.delta " +
        "response.output_text.delta response.output_text.done response.content_part.done response.output_item.done response.completed",
    types.join(" ")
  )
  const fin = vus[vus.length - 1]
  check("le texte est recollé dans l'ordre", fin.response.output[0].content[0].text === "BONJOUR")
  check("**et les jetons arrivent avec**", fin.response.usage.input_tokens === 11 && fin.response.usage.output_tokens === 3, JSON.stringify(fin.response.usage))
  // Un tour sans compte vaut zéro, pas un trou : le reçu du panneau additionne.
  const vide = new mod.Translator("m", "x")
  vide.push({ choices: [{ delta: { content: "a" } }] })
  check("un compte absent vaut zéro", vide.end().at(-1).response.usage.total_tokens === 0)
}

// ---- un appel d'outil, morceau par morceau -------------------------------
{
  const t = new mod.Translator("m", "essai")
  t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "exec_command", arguments: '{"cmd"' } }] } }] })
  t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] })
  const fin = t.end()
  const item = fin.find((e) => e.type === "response.output_item.done").item
  check("**les morceaux d'arguments se recollent dans l'ordre**", item.arguments === '{"cmd":"ls"}', item.arguments)
  check("et l'appel garde l'identifiant que codex devra citer", item.call_id === "call_9")
  check("le nom vient du premier morceau, le seul qui le porte", item.name === "exec_command")
  const types = fin.map((e) => e.type)
  check(
    "**et il est annoncé, rempli, fermé**",
    types.join(" ") === "response.output_item.added response.function_call_arguments.delta response.function_call_arguments.done response.output_item.done response.completed",
    types.join(" ")
  )
}

// ---- une erreur amont est une erreur -------------------------------------
{
  const t = new mod.Translator("m", "essai")
  const rendu = t.push({ error: { message: "The number of tokens to keep from the initial prompt is greater than the context length" } })
  check("**une erreur dans le flux amont devient un échec**", rendu.length === 1 && rendu[0].type === "response.failed", JSON.stringify(rendu))
  check("en gardant les mots du serveur", rendu[0].response.error.message.includes("context length"))
  check("**et rien ne se termine « réussi » derrière**", t.end().length === 0, "un tour vide passe pour un tour qui a marché")
}

// ---- la passerelle entière, contre un serveur amont pour de faux ---------
{
  // Un serveur Chat Completions qui répond comme LM Studio : des `data:`, un
  // `[DONE]`, et le compte à la fin.
  let vuParAmont = null
  const amont = createServer((req, res) => {
    let brut = ""
    req.on("data", (c) => (brut += c))
    req.on("end", () => {
      if (req.url.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [] }))
        return
      }
      vuParAmont = { body: JSON.parse(brut), auth: req.headers.authorization }
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const morceau of ["BON", "JOUR"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: morceau } }] })}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n`)
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise((r) => amont.listen(0, "127.0.0.1", r))
  const portAmont = amont.address().port

  const g = await mod.startGateway()
  g.aim("lmstudio/qwen3-coder-next", {
    provider: "lmstudio",
    url: `http://127.0.0.1:${portAmont}`,
    key: "clef-du-fournisseur",
    model: "qwen3-coder-next",
  })

  const poster = (corps, jeton = g.token) =>
    fetch(`${g.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jeton}` },
      body: JSON.stringify(corps),
    })

  // Ce serveur porte les clefs des fournisseurs : sans jeton, il serait un
  // relais anonyme pour tout ce qui tourne sur la machine.
  const sansJeton = await poster(REQUETE, "pas-le-bon")
  check("**sans le jeton, la passerelle ne relaie rien**", sansJeton.status === 401, String(sansJeton.status))

  const inconnu = await poster({ ...REQUETE, model: "un-modele-que-personne-ne-sert" })
  check("**un modèle qu'elle ne sert pas est nommé, pas deviné**", inconnu.status === 404)
  check("et elle dit ce qu'elle sert", (await inconnu.json()).error.message.includes("lmstudio/qwen3-coder-next"))

  const reponse = await poster(REQUETE)
  const flux = await reponse.text()
  check("**un tour entier traverse**", reponse.status === 200 && flux.includes("response.completed"), flux.slice(0, 200))
  check("le texte du modèle y est", flux.includes("BONJOUR"))
  check("les événements sont nommés dans l'entête SSE", flux.includes("event: response.output_text.delta"))
  check("**et le compte de jetons remonte**", flux.includes('"input_tokens":7'), flux.slice(-300))

  check("**la clef du fournisseur part vers le fournisseur**", vuParAmont.auth === "Bearer clef-du-fournisseur")
  check("et pas le jeton de la passerelle", !JSON.stringify(vuParAmont).includes(g.token))
  check("le serveur amont reçoit bien du Chat Completions", Array.isArray(vuParAmont.body.messages) && vuParAmont.body.stream === true)

  // Un fournisseur éteint : le message doit nommer QUI est éteint, sinon
  // « fetch failed » se cherche à l'aveugle quand on en a trois.
  g.aim("eteint/rien", { provider: "lmstudio", url: "http://127.0.0.1:1", key: "", model: "rien" })
  const mort = await poster({ ...REQUETE, model: "eteint/rien" })
  const detail = await mort.json()
  check("**un fournisseur éteint est nommé**", mort.status === 502 && detail.error.message.includes("127.0.0.1:1"), JSON.stringify(detail))

  g.close()
  amont.close()
}

console.log(
  failures === 0
    ? "\nLa passerelle traduit ce que codex dit vers ce que nos serveurs comprennent, et une erreur reste une erreur."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
