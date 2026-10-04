// Les questions de l'agent : un formulaire, un bouton Submit, et la réponse
// qui repart dans la forme que chaque harnais attend.
//
// Ce qui casse en silence ici :
//
// 1. **Une réponse dans la mauvaise forme.** Claude veut `updatedInput.answers`
//    indexé par le TEXTE de la question, une chaîne par question ; Codex veut
//    `{ answers: { <id>: { answers: [..] } } }`. Une clé de travers et l'agent
//    lit « pas de réponse » sans que rien n'échoue.
//
// 2. **La question retirée.** `--permission-prompts none` retire
//    AskUserQuestion des outils de Claude, et Codex ne l'offre hors du mode
//    plan qu'avec un drapeau. Sans eux, l'agent pose sa question en texte et
//    termine son tour.
//
// 3. **Un niveau qui accorde plus qu'avant.** L'outil des questions remplace
//    `--permission-prompts none` dans les niveaux qui ne demandent rien : tout
//    ce qui n'est pas une question doit y être refusé, sans rien demander.
//
// Les formes natives ont été relevées sur claude 2.1.288 et codex 0.159.1 :
// features/agent-questions.md.
//
//     node scripts/check-questions.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-questions-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "electron.js"),
  `module.exports = { app: { getPath: () => ${JSON.stringify(os.tmpdir())}, isPackaged: false }, nativeImage: {} }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/shared/questions")}"\n` +
    `export { CodexServerTurn, CODEX_QUESTIONS_FEATURE } from "${from("src/main/codexserver")}"\n` +
    `export { startShotsServer } from "${from("src/main/shots")}"\n` +
    `export { askIn, answerAsk } from "${from("src/main/asks")}"\n`
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
const tick = () => new Promise((r) => setImmediate(r))

// L'entrée d'AskUserQuestion telle que la CLI l'a envoyée, mot pour mot.
const claudeInput = {
  questions: [
    {
      question: "Which color do you prefer?",
      header: "Color",
      options: [
        { label: "Red", description: "The color red" },
        { label: "Blue", description: "The color blue" },
        { label: "Green", description: "The color green" },
      ],
      multiSelect: false,
    },
    {
      question: "Which features?",
      header: "Features",
      options: [
        { label: "Auth", description: "" },
        { label: "Search", description: "" },
      ],
      multiSelect: true,
    },
  ],
}

// ---- Claude : la traduction ------------------------------------------------
{
  const qs = m.questionsFromClaude(claudeInput)
  check("**les questions de Claude sont lues, indexées par leur texte**", qs?.length === 2 && qs[0].id === "Which color do you prefer?" && qs[0].options.length === 3)
  check("le choix multiple est retenu", qs[1].multiSelect === true && qs[0].multiSelect === false)
  check("« Autre » est toujours offert : le schéma de Claude l'interdit dans la liste", qs.every((q) => q.other === true))
  check("une entrée sans questions n'est pas un formulaire", m.questionsFromClaude({ command: "ls" }) === null)

  const rendu = m.claudeAnswerInput(claudeInput, qs, { [qs[0].id]: ["Blue"], [qs[1].id]: ["Auth", "Search"] })
  check(
    "**la réponse est l'entrée plus `answers`, par texte de question**",
    rendu.answers["Which color do you prefer?"] === "Blue" && rendu.questions === claudeInput.questions,
    JSON.stringify(rendu.answers)
  )
  check("**un choix multiple est joint par des virgules**", rendu.answers["Which features?"] === "Auth, Search")
}

// ---- Codex : la traduction ---------------------------------------------------
const codexParams = {
  threadId: "t",
  turnId: "u",
  itemId: "call_1",
  isBlocking: true,
  autoResolutionMs: null,
  questions: [
    { id: "preferred_color", header: "Color", question: "Which color do you prefer?", isOther: true, isSecret: false, options: [{ label: "Red", description: "Choose Red." }] },
    { id: "token", header: "Token", question: "Paste your token", isOther: false, isSecret: true, options: null },
  ],
}
{
  const qs = m.questionsFromCodex(codexParams)
  check("**les questions de Codex sont lues, indexées par leur id**", qs.length === 2 && qs[0].id === "preferred_color")
  check("une question sans option devient un champ libre", qs[1].other === true && qs[1].options.length === 0)
  check("une saisie secrète reste secrète", qs[1].secret === true)
  const result = m.codexAnswerResult(qs, { preferred_color: ["Blue"] })
  check(
    "**la réponse est `{ answers: { id: { answers: [..] } } }`**",
    JSON.stringify(result) === JSON.stringify({ answers: { preferred_color: { answers: ["Blue"] }, token: { answers: [] } } }),
    JSON.stringify(result)
  )
}

// ---- Claude : l'outil de permission et l'outil des questions -----------------
{
  const demandes = []
  let reponse = { allow: true }
  const handle = await m.startShotsServer(
    () => [],
    undefined,
    async (req) => {
      demandes.push(req)
      return reponse
    }
  )
  const post = (body) =>
    fetch(handle.origin, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${handle.token}` },
      body: JSON.stringify(body),
    }).then((r) => r.json())
  const call = async (name, args) => JSON.parse((await post({ id: 1, method: "tools/call", params: { name, arguments: args } })).result.content[0].text)

  const noms = (await post({ id: 1, method: "tools/list" })).result.tools.map((t) => t.name)
  check("**l'outil des questions est servi**", noms.includes("zyvro_questions") && noms.includes("zyvro_permission"), noms.join(", "))

  reponse = { allow: true, answers: { "Which color do you prefer?": ["Blue"], "Which features?": ["Auth"] } }
  const repondu = await call("zyvro_questions", { tool_name: "AskUserQuestion", input: claudeInput, tool_use_id: "toolu_1" })
  check("**la question monte au panneau en formulaire**", demandes.at(-1)?.questions?.length === 2)
  check(
    "**et les réponses repartent dans `updatedInput.answers`**",
    repondu.behavior === "allow" && repondu.updatedInput.answers["Which color do you prefer?"] === "Blue",
    JSON.stringify(repondu)
  )

  const avant = demandes.length
  const bash = await call("zyvro_questions", { tool_name: "Bash", input: { command: "echo > ../DEHORS.txt" } })
  check("**hors des questions, l'outil des questions refuse**", bash.behavior === "deny", JSON.stringify(bash))
  check("**sans rien demander à personne**", demandes.length === avant)

  reponse = { allow: false, message: "you said no" }
  const saute = await call("zyvro_questions", { tool_name: "AskUserQuestion", input: claudeInput })
  check("« Skip » est un refus que l'agent peut lire", saute.behavior === "deny" && saute.message === "you said no")

  reponse = { allow: true, answers: { "Which color do you prefer?": ["Red"] } }
  const parAsk = await call("zyvro_permission", { tool_name: "AskUserQuestion", input: claudeInput })
  check("**en mode Ask aussi, une question est un formulaire, pas Allow/Deny**", parAsk.updatedInput?.answers?.["Which color do you prefer?"] === "Red", JSON.stringify(parAsk))

  reponse = { allow: true }
  const permis = await call("zyvro_permission", { tool_name: "Bash", input: { command: "npm test" } })
  check("une permission ordinaire reste ce qu'elle était", permis.behavior === "allow" && permis.updatedInput.command === "npm test")
  handle.close()
}

// ---- La file des demandes : réponse, retrait --------------------------------
{
  const envoye = []
  const fenetre = { send: (canal, payload) => envoye.push({ canal, payload }), isDestroyed: () => false }
  const promesse = m.askIn(fenetre, { tool: "request_user_input", input: {}, questions: [{ id: "q" }] })
  const pose = envoye.find((e) => e.canal === "agent:permission")
  check("la demande part vers la fenêtre, avec ses questions", pose?.payload.questions?.[0].id === "q")
  check("**la réponse du panneau la règle**", m.answerAsk(pose.payload.id, { allow: true, answers: { q: ["oui"] } }) === true)
  check("avec ses réponses", (await promesse).answers.q[0] === "oui")
  check("une seconde réponse n'a plus personne à qui parler", m.answerAsk(pose.payload.id, { allow: true }) === false)

  const ctrl = new AbortController()
  const retiree = m.askIn(fenetre, { tool: "x", input: {} }, ctrl.signal)
  const id = envoye.filter((e) => e.canal === "agent:permission").at(-1).payload.id
  ctrl.abort()
  check("**une demande retirée quitte l'écran**", envoye.some((e) => e.canal === "agent:permission-gone" && e.payload.id === id))
  check("et rend un refus", (await retiree).allow === false)
}

// ---- Codex : le dialogue -----------------------------------------------------
{
  const ecrit = []
  const posees = []
  let repondre = null
  const tour = new m.CodexServerTurn(
    (l) => ecrit.push(JSON.parse(l)),
    () => {},
    () => {},
    (questions, signal) =>
      new Promise((resolve) => {
        posees.push({ questions, signal })
        repondre = resolve
      })
  )
  void tour.start({ cwd: "/p", model: null, sandbox: "workspace-write", approvalPolicy: "never", resume: null, input: [] })
  await tick()
  const init = ecrit.find((r) => r.method === "initialize")
  check("**l'API expérimentale est demandée : requestUserInput en fait partie**", init?.params.capabilities?.experimentalApi === true)

  tour.onLine(JSON.stringify({ method: "item/tool/requestUserInput", id: 0, params: codexParams }))
  await tick()
  check("**la question de Codex monte au panneau**", posees[0]?.questions[0].id === "preferred_color")
  check("au lieu d'être refusée", !ecrit.some((r) => r.id === 0 && r.error))
  repondre({ preferred_color: ["Blue"] })
  await tick()
  const reponse = ecrit.find((r) => r.id === 0 && r.result)
  check("**et la réponse redescend, par id**", reponse?.result.answers.preferred_color.answers[0] === "Blue", JSON.stringify(reponse))

  tour.onLine(JSON.stringify({ method: "item/tool/requestUserInput", id: 1, params: codexParams }))
  await tick()
  tour.onLine(JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "t", requestId: 1 } }))
  check("**réglée par le serveur — tour interrompu —, la question est retirée**", posees[1]?.signal.aborted === true)
  repondre(null)
  await tick()
  check("et personne ne répond à une requête close", !ecrit.some((r) => r.id === 1 && !r.method), JSON.stringify(ecrit.filter((r) => r.id === 1)))

  tour.onLine(JSON.stringify({ method: "item/tool/requestUserInput", id: 2, params: codexParams }))
  await tick()
  tour.closed()
  check("le serveur sorti, ce qui attendait est retiré", posees[2]?.signal.aborted === true)

  tour.onLine(JSON.stringify({ id: 9, method: "item/commandExecution/requestApproval", params: {} }))
  check("une approbation, elle, reste refusée", ecrit.some((r) => r.id === 9 && r.error))

  check(
    "**l'outil est offert hors du mode plan, par `-c` qui tolère un nom inconnu**",
    JSON.stringify(m.CODEX_QUESTIONS_FEATURE) === JSON.stringify(["-c", "features.default_mode_request_user_input=true"])
  )
  const agent = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  check("et le serveur d'application le reçoit", /\["app-server", \.\.\.CODEX_QUESTIONS_FEATURE,/.test(agent))
}

// ---- Le panneau ----------------------------------------------------------------
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  check("**une demande avec questions s'affiche en formulaire**", /ask\.questions \? \(\s*<QuestionCard/.test(panel))
  check("Submit envoie les réponses, Skip refuse", /onSubmit=\{\(answers\) => answerAsk\(ask\.id, true, answers\)\}/.test(panel) && /onSkip=\{\(\) => answerAsk\(ask\.id, false\)\}/.test(panel))
  check("une demande retirée quitte l'écran", /onPermissionGone\(/.test(panel))
  const card = readFileSync(path.join(ROOT, "src/renderer/panels/QuestionCard.tsx"), "utf8")
  check("**Submit attend que chaque question ait une réponse**", /disabled=\{!complete \|\| pending\}/.test(card))
}

console.log(
  failures === 0
    ? "\nL'agent pose ses questions dans un formulaire, et la réponse lui revient dans sa forme."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
