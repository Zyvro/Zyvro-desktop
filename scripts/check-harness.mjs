// Trois harnais, une seule liste.
//
// Un harnais est le programme qui tient la boucle — lire un fichier, lancer une
// commande, redemander au modèle. Le panneau en pilote trois, et chacun a ses
// drapeaux, son protocole et sa façon de raconter ce qu'il fait.
//
// Ce qui casse en silence ici :
//
// 1. **Les listes qui se multiplient.** Avant ce module, « claude | codex »
//    était écrit trois fois : dans le type du processus principal, redéclaré
//    dans le préchargement, et une troisième fois à la main dans les boutons du
//    panneau. Un quatrième harnais, c'est trois endroits à changer et un qu'on
//    oublie. Pire, le routage de l'envoi disait « codex, sinon claude » : un
//    nom inconnu devenait claude sans un mot, le panneau affichait « qwen » et
//    claude répondait.
//
// 2. **Un drapeau mal orthographié n'est pas refusé, il est ignoré.** Qwen Code
//    écrit `--allowed-tools` avec des tirets là où claude écrit `--allowedTools`.
//    Recopier l'un pour l'autre ne produit aucune erreur : les outils de Zyvro
//    manquent, et l'agent dit qu'il n'a pas la permission d'une chose qu'on
//    vient de lui offrir.
//
// 3. **`--bare`.** Sans lui, Qwen Code fait sa découverte automatique avant de
//    répondre — deux requêtes de 26 000 jetons. Mesuré sur la même question :
//    190 s avec, 10 s sans.
//
// 4. **La visée.** « lmstudio/qwen3-coder-next » nomme un serveur ET un modèle.
//    Les séparer laisserait exister « le modèle de LM Studio, demandé à
//    Ollama », qui répond 404 et n'apprend rien à personne.
//
//     node scripts/check-harness.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-harness-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/shared/harness")}"\n` +
    `export { argsFor, promptWith, qwenPermission, aimArgs, aimEnv, AgentRunner } from "${from("src/main/agent")}"\n` +
    `export { startShotsServer } from "${from("src/main/shots")}"\n`
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

const ctx = { projectDir: "/tmp/projet", workflows: [] }
const appServer = await mod.startShotsServer(() => [], undefined, async () => ({ allow: true }))

// ---- une seule liste -----------------------------------------------------
{
  check("**trois harnais**", mod.AGENT_KINDS.join(",") === "claude,codex,qwen", mod.AGENT_KINDS.join(","))

  // Le type est déclaré une fois. Un fichier qui le redéclare est une liste de
  // plus, et c'est exactement ce qu'il y avait ici.
  const redeclared = ["src/main/agent.ts", "src/preload/index.ts"].filter((rel) =>
    /export type AgentKind =/.test(readFileSync(path.join(ROOT, rel), "utf8"))
  )
  check("**personne ne redéclare la liste des harnais**", redeclared.length === 0, redeclared.join(", "))

  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  check("et le sélecteur la prend telle quelle", panel.includes("AGENT_KINDS.map("))

  // Le choix vit dans le corps d'une session neuve, pas dans la barre du haut :
  // c'est le moment où il se décide, et la barre déborde à trois boutons de
  // plus — le bouton de droite sortait de l'écran, déjà vu avec « Run workflow ».
  const entete = panel.slice(panel.indexOf('className="flex h-9 shrink-0'), panel.indexOf("ref={scrollRef}"))
  check(
    "**et le choix du harnais n'est pas dans la barre du haut**",
    !entete.includes("AGENT_KINDS.map("),
    "l'en-tête porte encore les boutons de harnais"
  )
  check(
    "une session commencée y rappelle le sien sans le proposer",
    entete.includes("started ?") && entete.includes("{kind}")
  )
  check(
    "plutôt que d'écrire les noms dans ses boutons",
    !/\[\s*"claude"\s*,\s*"codex"/.test(panel),
    "le panneau porte encore sa propre liste"
  )

  // « codex, sinon claude » : la forme qui transformait tout nouveau harnais en
  // claude sans rien dire.
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  check(
    '**un harnais inconnu ne devient pas claude en silence**',
    !/kind === "codex" \? "codex" : "claude"/.test(ipc) && ipc.includes("isAgentKind(kind)"),
    "ipc.ts rabat encore le harnais sur deux valeurs"
  )

  check("un nom qui ne veut rien dire n'en est pas un", !mod.isAgentKind("gpt") && !mod.isAgentKind(null))
  check(
    "mais une vieille conversation ne fait pas tomber le panneau",
    mod.harness("un-harnais-retiré").kind === "claude"
  )
}

// ---- ce que chaque harnais reçoit ----------------------------------------
{
  const argv = (kind, opts = {}) =>
    mod.argsFor(kind, ctx, opts.resume ?? null, opts.model ?? null, opts.images ?? [], opts.aim ?? null)
  const args = (kind, opts = {}) => argv(kind, opts).join(" ")
  // `--approval-mode` contient « -m ». Un drapeau se cherche donc entier, dans
  // la liste, et pas comme un morceau de texte dans la ligne — la première
  // version de ce garde échouait sur son propre test.
  const has = (kind, flag, opts = {}) => argv(kind, opts).includes(flag)

  const claude = args("claude")
  check("claude garde sa ligne", claude.includes("-p") && claude.includes("--output-format stream-json"))

  const codex = args("codex")
  check("codex garde la sienne", codex.includes("exec") && codex.includes("--json"))

  const qwen = args("qwen")
  check("**qwen coupe la découverte automatique**", qwen.includes("--bare"), qwen)
  check("et imprime un événement par ligne", qwen.includes("-o stream-json"), qwen)
  check("avec un mode d'approbation, toujours", /--approval-mode \S+/.test(qwen), qwen)
  check("et le préambule du projet", qwen.includes("--append-system-prompt"), qwen)

  // Le drapeau du modèle n'est pas le même chez les trois.
  check("claude épingle avec --model", args("claude", { model: "opus" }).includes("--model opus"))
  check("qwen épingle avec -m", args("qwen", { model: "qwen3-coder" }).includes("-m qwen3-coder"))

  // Reprendre une conversation : un drapeau chez deux d'entre eux, une
  // sous-commande chez le troisième.
  check("qwen reprend par --resume", args("qwen", { resume: "s1" }).includes("--resume s1"))

  // Un modèle vide n'est pas un modèle : `-m ""` est refusé par la CLI, et la
  // personne voit un échec pour une case qu'elle a simplement laissée tranquille.
  check("**une case laissée vide n'envoie pas de drapeau**", !has("qwen", "-m", { model: "   " }))
}

// ---- les permissions, dans le vocabulaire de chacun -----------------------
{
  check("lire seulement, c'est le mode plan", mod.qwenPermission("read").join(" ") === "--approval-mode plan")
  check("tout permettre, c'est yolo", mod.qwenPermission("yolo").join(" ") === "--approval-mode yolo")
  check("demander, c'est default", mod.qwenPermission("ask", true).join(" ") === "--approval-mode default")
  // Demander sans personne pour répondre est une attente infinie : un tour qui
  // ne rend jamais la main est pire qu'un tour qui ne peut rien écrire.
  check(
    "**mais on ne demande pas à un panneau qui ne peut pas répondre**",
    mod.qwenPermission("ask", false).join(" ") === "--approval-mode plan"
  )
}

// ---- l'enveloppe décide, pas le nom --------------------------------------
{
  check("**qwen et claude partagent une enveloppe**", mod.harness("qwen").envelope === "claude")
  check("codex a la sienne", mod.harness("codex").envelope === "codex")

  const agent = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  check(
    "et l'analyseur se choisit sur l'enveloppe",
    agent.includes('harness(kind).envelope === "claude"'),
    "le flux est encore lu sur le nom du harnais"
  )

  // Les deux harnais à enveloppe claude lisent une image par son chemin ; codex
  // la reçoit en argument et n'a rien à lire dans le texte.
  const images = ["/tmp/a.png"]
  check("les deux nomment l'image dans le texte", mod.promptWith("qwen", "salut", images).includes("/tmp/a.png"))
  check("codex ne la nomme pas deux fois", mod.promptWith("codex", "salut", images) === "salut")
}

// ---- viser ----------------------------------------------------------------
{
  check("**un modèle visé nomme le serveur et le modèle**", JSON.stringify(mod.splitAimed("lmstudio/qwen3-coder-next")) === JSON.stringify({ provider: "lmstudio", model: "qwen3-coder-next" }))
  check("un modèle ordinaire ne vise rien", mod.splitAimed("opus") === null)
  check("ni une barre oblique toute seule", mod.splitAimed("/x") === null && mod.splitAimed("x/") === null)
  // Un nom de modèle Ollama contient un deux-points et parfois une barre :
  // seule la PREMIÈRE sépare le serveur du modèle.
  check(
    "**et le nom du modèle garde ses barres**",
    mod.splitAimed("ollama-local/qwen2.5:0.5b").model === "qwen2.5:0.5b" &&
      mod.splitAimed("custom/org/modèle").model === "org/modèle"
  )
  check("aller-retour", mod.splitAimed(mod.joinAimed("lmstudio", "a/b")).model === "a/b")

  const aim = { provider: "lmstudio", url: "http://127.0.0.1:1234/v1", key: "", model: "qwen3-coder-next" }
  const flags = mod.aimArgs(aim).join(" ")
  check("**la visée nomme le modèle**", flags.includes("-m qwen3-coder-next"), flags)
  check("et un type d'authentification", flags.includes("--auth-type openai"), flags)
  // Un serveur local n'en demande pas, mais le client en exige une : sans
  // valeur, Qwen Code réclame une connexion au lieu d'appeler.
  // Le fond de l'affaire : une clef sur la ligne de commande se lit dans `ps`,
  // pour tout ce qui tourne sur la machine. Ce panneau écrit déjà la question
  // sur stdin pour cette raison exacte.
  const secret = { provider: "custom", url: "https://exemple.test/v1", key: "sk-tres-secrete", model: "m" }
  const ligne = mod.argsFor("qwen", ctx, null, "custom/m", [], secret).join(" ")
  check("**la clef ne passe jamais par la ligne de commande**", !ligne.includes("sk-tres-secrete"), ligne)
  check("ni l'adresse", !ligne.includes("exemple.test"), ligne)
  check(
    "**elle arrive par l'environnement**",
    mod.aimEnv(secret).OPENAI_API_KEY === "sk-tres-secrete" &&
      mod.aimEnv(secret).OPENAI_BASE_URL === "https://exemple.test/v1",
    JSON.stringify(mod.aimEnv(secret))
  )
  // Un serveur local n'en demande pas, mais le client en exige une : sans
  // valeur, Qwen Code réclame une connexion au lieu d'appeler.
  check("**une clef de remplissage plutôt qu'une demande de connexion**", mod.aimEnv(aim).OPENAI_API_KEY === "local")

  // Et c'est le processus principal qui la pose, pas le rendu.
  const agentSrc = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  check(
    "et c'est le processus principal qui la pose",
    agentSrc.includes("if (aim) Object.assign(env, aimEnv(aim))"),
    "personne ne met la visée dans l'environnement du sous-processus"
  )
  // Elle vient du moteur, qui la détient, et pas du catalogue affiché.
  const aimSrc = readFileSync(path.join(ROOT, "src/main/aim.ts"), "utf8")
  check(
    "**et elle est demandée au moteur par son nom**",
    aimSrc.includes("/endpoint`"),
    "la clef n'est jamais demandée : un point d'accès distant se ferait refuser"
  )

  // Visé, le modèle vient de la visée : envoyer les deux, c'est `-m` deux fois.
  const both = mod.argsFor("qwen", ctx, null, "lmstudio/qwen3-coder-next", [], aim).join(" ")
  check(
    "**un seul -m quand le harnais est visé**",
    mod.argsFor("qwen", ctx, null, "lmstudio/qwen3-coder-next", [], aim).filter((a) => a === "-m").length === 1,
    both
  )

  // Seul un harnais visable l'est. Donner une adresse à claude ne ferait rien
  // de bon : elle devrait parler son protocole, et c'est une traduction à
  // écrire, pas un drapeau à poser.
  check("claude ne se vise pas", mod.harness("claude").aimable === false)
  check("codex non plus", mod.harness("codex").aimable === false)
  check("**qwen, si**", mod.harness("qwen").aimable === true)
  check(
    "et un harnais non visable ignore une visée qu'on lui passerait",
    !mod.argsFor("claude", ctx, null, null, [], aim).join(" ").includes("--auth-type")
  )
}

// ---- une session, un harnais ---------------------------------------------
//
// « Et oui, une session = un harness sélectionné. »
//
// Trouvé en s'en servant, pas en relisant : une conversation commencée avec
// claude, basculée sur qwen, lançait `qwen --resume <identifiant de claude>`.
// Qwen Code répond « No saved session found with ID … », et c'est cette phrase
// qui arrive dans le panneau à la place de la réponse.
{
  const runner = new mod.AgentRunner()
  const fil = "conversation-1"

  runner.resumeAt("claude", fil, "session-de-claude")
  check("**ce que claude sait, claude le retrouve**", runner.sessionFor("claude", fil) === "session-de-claude")
  check(
    "**et qwen ne le reprend pas à son compte**",
    runner.sessionFor("qwen", fil) === null,
    String(runner.sessionFor("qwen", fil))
  )

  runner.resumeAt("qwen", fil, "session-de-qwen")
  check("chacun garde le sien", runner.sessionFor("claude", fil) === "session-de-claude" && runner.sessionFor("qwen", fil) === "session-de-qwen")
  check(
    "et les deux sont écrits sur le disque",
    JSON.stringify(runner.sessionsFor(fil)) === JSON.stringify({ claude: "session-de-claude", qwen: "session-de-qwen" }),
    JSON.stringify(runner.sessionsFor(fil))
  )

  // Deux conversations ne se mélangent pas non plus.
  runner.resumeAt("claude", "conversation-2", "autre")
  check("deux conversations restent deux", runner.sessionFor("claude", fil) === "session-de-claude")

  // Oublier une conversation l'oublie chez tout le monde : la garder chez un
  // harnais laisserait une conversation supprimée reprendre vie en basculant.
  runner.forget(fil)
  check("**oublier une conversation l'oublie chez les trois**", Object.keys(runner.sessionsFor(fil)).length === 0)
  check("sans toucher à la voisine", runner.sessionFor("claude", "conversation-2") === "autre")

  // Un fichier écrit avant cette séparation ne porte qu'un identifiant. Il
  // appartient au harnais que la conversation portait alors — le lire autrement
  // serait le donner au mauvais.
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  check(
    "**une vieille conversation rend sa session à son harnais**",
    ipc.includes("conversation.sessions ??") && ipc.includes("[conversation.kind]: conversation.sessionId"),
    "la reprise d'un ancien fichier ne dit pas de quel harnais il parle"
  )
}

// ---- une session garde son harnais ---------------------------------------
//
// « Une fois le premier message sent, harnais impossible à changer sur cette
// session. » C'est lui qui tient le fil côté CLI : la session qu'on reprend
// d'un tour à l'autre lui appartient, et en changer au milieu revient à
// demander à quelqu'un d'autre de finir une phrase qu'il n'a pas entendue.
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  const setKind = panel.slice(panel.indexOf("function setKind"), panel.indexOf("function setKind") + 1200)
  check(
    "**une session commencée ne change plus de harnais**",
    /if \(thread\.messages\.length > 0\) return thread/.test(setKind),
    "setKind accepte encore de changer le harnais d'une session en cours"
  )
  // La règle ne vit pas dans l'affichage : un écran qui cache un bouton est une
  // politesse, pas une garantie.
  check(
    "et la règle ne dépend pas de l'écran qui cache le bouton",
    setKind.indexOf("return thread") < setKind.indexOf("models"),
    "la règle est posée après coup"
  )
  check(
    "le choix n'est offert que tant que rien n'est parti",
    panel.includes("const started = thread.messages.length > 0") && panel.includes("{!started ? ("),
    "l'écran ne distingue pas une session commencée"
  )
}

// ---- un modèle, un harnais -----------------------------------------------
//
// La même règle que pour la session, et le même défaut, trouvé de la même
// façon : une conversation épinglée sur « ollama-local/qwen2.5:0.5b » et
// basculée sur claude lui faisait répondre « There's an issue with the selected
// model » — un nom que claude n'a aucune raison de connaître, gardé parce qu'il
// vivait sur la conversation plutôt que sur le harnais.
{
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  check(
    "**basculer de harnais ne lui lègue pas le modèle du précédent**",
    /const models = \{ \.\.\.thread\.models, \[thread\.kind\]: thread\.model \}/.test(panel) &&
      /model: models\[kind\] \?\? null/.test(panel),
    "setKind garde le modèle épinglé tel quel"
  )
  check(
    "et ce que la CLI avait rapporté ne suit pas non plus",
    /ranWith: null/.test(panel.slice(panel.indexOf("function setKind"), panel.indexOf("function setKind") + 1400)),
    "le défaut affiché est celui de l'autre harnais"
  )
  check(
    "**revenir retrouve le sien**",
    panel.includes("models: { ...thread.models, [thread.kind]: model }"),
    "le choix n'est pas retenu par harnais"
  )
  check(
    "et il est écrit sur le disque",
    panel.includes("models: { ...thread.models, [thread.kind]: thread.model }"),
    "la carte des modèles n'est pas persistée"
  )
  check(
    "**une vieille conversation rend son modèle à son harnais**",
    panel.includes("c.models ?? (c.model ? { [c.kind]: c.model } : {})"),
    "la reprise d'un ancien fichier ne dit pas de quel harnais le modèle vient"
  )
}

await appServer?.stop?.()
console.log(
  failures === 0
    ? "\nTrois harnais, une liste, et chacun reçoit les drapeaux qui le font répondre."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
