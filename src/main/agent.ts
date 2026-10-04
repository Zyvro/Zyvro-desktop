import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { CODEX_QUESTIONS_FEATURE, codexInput, codexServerPolicy, CodexServerTurn } from "./codexserver"
import { askIn } from "./asks"
import { recordIncident } from "./bugreport"
import { installed as cliInstalled, launchPiped } from "./cli"
import { describeTool, imagesIn, outputIn, planIn } from "./tooltalk"
import { keep as keepImage } from "./attachments"
import { commandsIn, remember as rememberCommands } from "./commands"
import { type Goal, goalIn, sameGoal } from "./goal"
import { compactIn } from "./compact"
import { nextRunIn, type Pending, type Wake, wakeIn } from "./schedule"
import { startGateway, type GatewayHandle } from "./responses"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { readFileSync } from "node:fs"
import os from "node:os"
import type { WebContents } from "electron"
import { codexMcpArgs, mcpAvailable, mcpServers, mcpTokenEnv, writeMcpConfig, type McpDialect, type McpTarget } from "./mcp"
import { shotsEndpoint } from "./shots"
import { DEFAULT_PERMISSION, PERMISSION_TOOL, QUESTIONS_TOOL, type Permission } from "../shared/permission"
import { AGENT_KINDS, type Aim, type AgentKind, harness, SHELL_YOLO, speaksCodex } from "../shared/harness"
import { promptWithSkills, type AgentSettings, type SkillEntry } from "../shared/skills"

// The chat panel runs the user's own agent CLI in the project directory. That
// is the whole reason this app exists: a ChatGPT or Claude subscription cannot
// be reached from a server, but the CLI on this machine is already signed in.
// Zyvro never sees a token; it sees stdout.

// Les harnais vivent dans un module partagé : le principal les lance, le pont
// les fait traverser, le rendu les affiche. Une déclaration par côté, c'est la
// déclaration d'un côté qui oublie le troisième harnais.
export type { AgentKind } from "../shared/harness"

// Ce que l'agent a le droit de faire vit dans un module que les trois côtés
// partagent : le principal le traduit en drapeaux, le pont le fait traverser,
// le rendu l'affiche dans la barre du chat.
export { DEFAULT_PERMISSION, PERMISSION_TOOL, type Permission } from "../shared/permission"

export type AgentContext = {
  projectDir: string
  workflows: { id: string; name: string; description?: string }[]
  // The local daemon's origin and token. With them the CLI gets the Zyvro MCP
  // tools and can actually run a workflow; without them it can only read the
  // JSON files, which is the difference between an assistant that acts and one
  // that describes.
  daemonOrigin?: string
  daemonToken?: string
  /** Ce que l'agent a le droit de faire. Par défaut : écrire dans le projet. */
  permission?: Permission
  advancedSkills?: boolean
  agentSettings?: AgentSettings
  skills?: SkillEntry[]
}

// preamble tells the CLI what this project's workflows are. Without it the
// agent is a generic coding assistant that has never heard of Zyvro; with it,
// asking "run the product photo workflow" is a sentence it can act on.
function preamble(ctx: AgentContext): string {
  const lines = [
    `You are the Zyvro Studio assistant, working inside the project at ${ctx.projectDir}.`,
    "Zyvro workflows are visual AI graphs stored in .zyvro/workflows/ as JSON.",
  ]

  if (ctx.workflows.length === 0) {
    lines.push("This project has no workflows yet.")
  } else {
    lines.push(
      "This project defines these workflows:",
      ...ctx.workflows.map(
        (w) => `- ${w.name} (id ${w.id})${w.description ? `: ${w.description}` : ""}`
      )
    )
  }

  if (mcpAvailable(ctx)) {
    lines.push(
      "",
      "You have the Zyvro tools for this project. Use them rather than reading the",
      "JSON by hand: zyvro_list_workflows, zyvro_workflow_graph, zyvro_run_workflow,",
      "zyvro_execution_status, zyvro_get_output, zyvro_list_executions.",
      "Running a workflow spends the user's own model account, so run one when the",
      "user asks for it, not to satisfy your own curiosity about what it does."
    )
  }

  return lines.join("\n")
}

// claudeMcpConfig est le fichier que l'agent reçoit pour ce tour. La liste des
// serveurs vit dans mcp.ts, avec celle du shell : deux listes finiraient par
// différer, et la différence serait un outil manquant que rien ne signale.
export function claudeMcpConfig(ctx: AgentContext, dialecte: McpDialect = "claude"): { path: string; dispose: () => void } {
  return writeMcpConfig(ctx, dialecte)
}

// Print mode does not activate Chrome from the saved default on its own.
// Forward the user's opt-in explicitly; leave native skills/plugins/settings alone.
function claudeChromeArgs(): string[] {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json")
  try {
    return JSON.parse(readFileSync(file, "utf8")).claudeInChromeDefaultEnabled === true ? ["--chrome"] : []
  } catch {
    return []
  }
}

// argsFor builds the command line for one turn.
//
// Pulled out and exported so it can be pinned by a check, because this is the
// part that breaks silently. The two CLIs disagree about how a session is
// resumed, and neither complains when you get it wrong:
//
//   claude   --resume <id> is a flag, anywhere on the line
//   codex    resume is a SUBCOMMAND, before its options, with the id positional
//
// Put codex's id in the wrong place and it is read as the prompt: the process
// starts, the model answers a question made of a UUID, and nothing anywhere
// says the session was not resumed. That is the failure worth a test.
//
// Both shapes were checked against the installed binaries rather than recalled
// — `codex exec resume --help` prints `[OPTIONS] [SESSION_ID] [PROMPT]`.
export function argsFor(
  kind: AgentKind,
  ctx: AgentContext,
  resume: string | null,
  model: string | null = null,
  images: string[] = [],
  aim: Aim | null = null,
  // Par où codex atteint le fournisseur visé. Null quand il parle à son propre
  // compte, ou quand ce n'est pas lui.
  gateway: GatewayAim | null = null
): string[] {
  // An empty model is not a model. Passing `--model ""` is not the same as
  // passing nothing: the CLI takes it as a value and refuses it, and the user
  // sees a failure for a box they simply left alone.
  const pinned = model?.trim() ? model.trim() : null

  if (kind === "claude") {
    return [
      "-p",
      "--output-format",
      "stream-json",
      // L'entrée aussi en flux, et laissée ouverte pendant le tour : un message
      // écrit en plein tour y est lu au prochain point d'arrêt (steer).
      // `--replay-user-messages` le renvoie sur la sortie quand il est pris —
      // c'est l'accusé de réception que la fenêtre attend.
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--verbose",
      ...(!gateway ? claudeChromeArgs() : []),
      // Ce que l'agent a le droit de faire, dit à claude.
      //
      // Un tour en mode impression ne peut poser aucune question : sans ça, la
      // CLI demande la permission d'écrire, personne ne peut répondre, et
      // l'agent rend « you haven't granted it yet » pour un fichier du dossier
      // qu'on vient de lui ouvrir.
      // La question ne peut remonter que si le serveur MCP de l'application
      // tourne : c'est lui qui sert l'outil de permission. Sans lui, mieux vaut
      // refuser tout de suite que laisser l'agent attendre une réponse qui
      // n'arrivera pas. Et il n'est déclaré à la CLI que si les serveurs MCP le
      // sont (voir `--mcp-config` plus bas) : nommer un outil absent ferait
      // échouer chaque tour, et c'est maintenant le cas de tous les niveaux.
      ...claudePermission(ctx.permission ?? DEFAULT_PERMISSION, Boolean(shotsEndpoint()) && mcpAvailable(ctx)),
      "--append-system-prompt",
      preamble(ctx),
      ...(pinned ? ["--model", pinned] : []),
      ...(resume ? ["--resume", resume] : []),
      // claude has no image flag: it reads an image by path with its Read tool,
      // so the paths go in the prompt — see promptWith. But its tools are
      // confined to the working directory, and the attachments live beside the
      // conversation, outside the project. Without this the agent answers "la
      // permission a été refusée" for a file it was just handed, which is
      // exactly what it did the first time this was run.
      //
      // Only the directories the images are actually in, and only when there
      // are images: widening tool access for a turn that does not need it
      // would be paying for a feature nobody used.
      ...(images.length > 0 ? ["--add-dir", ...directoriesOf(images)] : []),
    ]
  }
  if (kind === "qwen") {
    // Qwen Code imprime la même enveloppe que Claude Code, et prend presque les
    // mêmes drapeaux. Les trois qui lui sont propres :
    //
    //   --bare              coupe la découverte automatique au démarrage.
    //                       Mesuré sur la même question : 190 s avec, 10 s
    //                       sans, parce que l'extracteur de mémoire lance deux
    //                       requêtes de 26 000 jetons avant de répondre.
    //   -o stream-json      un événement par ligne, comme claude.
    //   --auth-type + adresse  ce qui le vise ailleurs que sur son compte.
    //
    // `-p` est déprécié chez lui au profit de la question en positionnel ou sur
    // stdin ; elle arrive sur stdin, comme pour les deux autres, et pour la
    // même raison : elle ne doit pas se retrouver dans la table des processus.
    return [
      "--bare",
      "-o",
      "stream-json",
      ...qwenPermission(ctx.permission ?? DEFAULT_PERMISSION),
      "--append-system-prompt",
      preamble(ctx),
      ...(aim ? aimArgs(aim) : pinned ? ["-m", pinned] : []),
      ...(resume ? ["--resume", resume] : []),
      // Même raison que pour claude : ses outils de fichiers vivent dans le
      // dossier de travail, et les pièces jointes sont rangées ailleurs.
      ...(images.length > 0 ? ["--include-directories", directoriesOf(images).join(",")] : []),
    ]
  }

  if (kind === "mimo") {
    // MiMo Code : `mimo run`, son mode non interactif. Le flux d'opencode en
    // JSON, la question sur stdin (préambule compris, il n'a pas de drapeau de
    // prompt système), la session reprise par `--session`, les images jointes
    // par `--file`, une par occurrence.
    return [
      "run",
      "--format",
      "json",
      ...mimoPermission(ctx.permission ?? DEFAULT_PERMISSION),
      ...(pinned ? ["--model", pinned] : []),
      ...(resume ? ["--session", resume] : []),
      ...images.flatMap((file) => ["--file", file]),
    ]
  }

  return [
    "exec",
    ...(resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    // Le pendant côté codex, dans son vocabulaire à lui : un bac à sable.
    ...codexPermission(ctx.permission ?? DEFAULT_PERMISSION),
    ...(aim && gateway ? codexAimArgs(gateway) : []),
    // Le modèle épinglé est aussi la route de la passerelle : « lmstudio/
    // qwen3-coder-next » nomme le serveur et le modèle, et codex le renvoie
    // tel quel dans son corps de requête. C'est par là qu'elle sait où aller.
    ...(pinned ? ["--model", pinned] : []),
    // -i takes one path per occurrence. Several paths after a single -i would
    // be swallowed as one argument by some shells and as the prompt by codex.
    ...images.flatMap((file) => ["-i", file]),
    ...(resume ? [resume] : []),
  ]
}

// claudePermission et codexPermission : le même choix, dit à chacun.
//
// Sortis en fonctions et exportés pour qu'un test les épingle : ce sont des
// drapeaux dont l'absence ne fait rien échouer bruyamment, elle rend seulement
// l'agent impuissant ou, dans l'autre sens, sans limite.
export function claudePermission(permission: Permission, canAsk = true): string[] {
  switch (permission) {
    case "read":
      // Nommer les outils d'écriture plutôt que de compter sur un mode : un
      // refus clair, tout de suite. Et personne pour répondre au reste : ce qui
      // demanderait est refusé, sans attendre.
      return ["--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash", "--permission-mode", "manual", ...questionFlags(canAsk)]
    case "yolo":
      // Sans outil de permission, la CLI retire AskUserQuestion même ici. Avec,
      // seule la question l'atteint : le reste passe sans rien demander.
      return ["--dangerously-skip-permissions", ...(canAsk ? questionFlags(true) : [])]
    case "project":
      // Rien ne demande, et rien ne sort du projet.
      //
      // C'était `bypassPermissions`, sur la foi de son nom et d'un raisonnement
      // faux : « les outils de fichiers restent confinés au dossier de
      // travail ». Non. Signalé par Jeremy — « l'agent en mode workspace a pu
      // écrire un fichier hors du workspace » — et refait ici pour en être sûr :
      // en `bypassPermissions`, « écris dans ../DEHORS.txt » a créé le fichier
      // un niveau au-dessus du projet, sans un mot.
      //
      // `acceptEdits` est le mode qui tient la promesse, et les quatre ont été
      // essayés plutôt que choisis au nom :
      //
      //   bypassPermissions  écrit dehors           ✗
      //   auto               écrit dehors           ✗
      //   dontAsk            refuse dehors, mais refuse aussi dedans — ni
      //                      écriture ni commande, le mode ne sert plus à rien
      //   acceptEdits        écrit et lance des commandes DANS le projet,
      //                      refuse d'en sortir                            ✓
      //
      // Et il le tient pour le shell aussi, ce qui est le seul cas qui compte :
      // `echo sorti > ../DEHORS.txt` lancé par Bash a été refusé par la CLI
      // elle-même — « refusé par le système de permissions, pas par moi ».
      // Un garde de chemin écrit par nous n'aurait jamais attrapé ça : une
      // commande shell peut écrire n'importe où de mille façons qu'aucun
      // analyseur ne voit.
      //
      // Ce qui demanderait doit être refusé plutôt que d'attendre une réponse :
      // c'est l'outil des questions qui le refuse (voir questionFlags), et lui
      // seul laisse passer les questions de l'agent jusqu'au panneau.
      return ["--permission-mode", "acceptEdits", ...questionFlags(canAsk)]
    default:
      // Tout demande, et la question arrive dans le panneau.
      //
      // `manual` est le mode qui demande : c'est lui qui décide, pas le
      // routage. Vérifié contre le binaire — sans lui, une écriture passe sans
      // rien demander, et « Ask » ne demandait rien du tout.
      return ["--permission-mode", "manual", ...(canAsk ? askFlags() : ["--permission-prompts", "none"])]
  }
}

function askFlags(): string[] {
  return ["--permission-prompts", "host", "--permission-prompt-tool", PERMISSION_TOOL]
}

// questionFlags : les niveaux qui ne demandent rien posent quand même les
// questions de l'agent.
//
// `--permission-prompts none` refuse ce qui demanderait, comme voulu, mais
// retire aussi AskUserQuestion des outils : le modèle ne la voit plus et pose
// sa question en texte, en fin de tour. L'outil des questions la remplace —
// il fait monter les questions au panneau et refuse tout le reste. Mesuré sur
// la 2.1.288 : en « Read only », « Project » et « YOLO », seule la question
// l'atteint ; une commande dans le projet, une lecture, passent sans lui.
//
// Sans le serveur de l'application, personne pour répondre : on revient au
// refus pur.
function questionFlags(canAsk: boolean): string[] {
  return canAsk ? ["--permission-prompts", "host", "--permission-prompt-tool", QUESTIONS_TOOL] : ["--permission-prompts", "none"]
}

// codex ne sait pas demander en cours de tour : `codex exec` n'a pas de crochet
// d'approbation qu'on puisse brancher sur l'interface. Son bac à sable est donc
// la réponse — il décide d'avance de ce qui est possible, au lieu de demander.
//
// **Par `-c` et pas par `--sandbox`**, et ce n'est pas un détail de style : le
// deuxième tour d'une session codex mourait dessus.
//
//   error: unexpected argument '--sandbox' found
//   Usage: codex exec resume --json --skip-git-repo-check [SESSION_ID] [PROMPT]
//
// `codex exec resume` n'accepte pas ce drapeau — relevé dans son `--help`, et
// vu d'abord à l'écran : une session répondait au premier message et refusait
// tous les suivants. Le réglage existe sous forme de configuration, que les
// deux sous-commandes acceptent, donc une seule écriture sert les deux chemins.
// Deux formes pour le même réglage, c'est celle qu'on écrit le moins souvent
// qui se trompe — ici, c'était la reprise, c'est-à-dire tout sauf le premier
// message.
//
// Éprouvé, pas déduit : `-c sandbox_mode=workspace-write` refuse
// « echo sorti > ../DEHORS.txt » au premier tour comme à la reprise, et
// `-c sandbox_mode=read-only` refuse aussi d'écrire DANS le projet.
export function codexPermission(permission: Permission): string[] {
  switch (permission) {
    case "read":
      return ["-c", "sandbox_mode=read-only"]
    case "yolo":
      // Celui-là, `resume` l'accepte : c'est un drapeau des deux.
      return ["--dangerously-bypass-approvals-and-sandbox"]
    default:
      // Le dossier du projet, et nulle part ailleurs.
      return ["-c", "sandbox_mode=workspace-write"]
  }
}

// qwenPermission : le même choix encore, dans le vocabulaire de Qwen Code.
//
// Ses modes portent d'autres noms et ne se recouvrent pas exactement :
// `plan` n'écrit rien et n'exécute rien, `auto-edit` écrit mais ne lance pas de
// commande, `yolo` ne demande jamais. Le mode qui demande est `default`, et il
// ne peut demander que si quelqu'un peut répondre — sinon le tour attend une
// réponse qui n'arrivera pas, exactement comme claude.
export function qwenPermission(permission: Permission, canAsk = true): string[] {
  switch (permission) {
    case "read":
      return ["--approval-mode", "plan"]
    case "yolo":
      return ["--approval-mode", "yolo"]
    case "project":
      // `auto-edit` écrit sans demander mais ne lance pas de commande.
      //
      // C'était `yolo`, avec le même raisonnement faux que du côté de claude —
      // « ses outils de fichiers vivent dans son dossier de travail » — et
      // `yolo` veut dire « ne demande jamais », pas « reste ici ». Le trou a
      // été prouvé chez claude le 18/09 ; il n'y a aucune raison de croire que
      // celui-ci soit différent.
      //
      // **Non vérifié sur le binaire** : Qwen Code n'est plus installé sur
      // cette machine. Pour le vérifier, l'installer puis, dans un dossier
      // `projet/` :
      //
      //   qwen --approval-mode auto-edit -p "écris 'sorti' dans ../DEHORS.txt"
      //
      // et regarder si le fichier apparaît un niveau au-dessus. En attendant,
      // le choix va au mode le moins permissif des deux : une frontière qu'on
      // n'a pas pu mesurer se place du côté sûr, quitte à refuser un shell que
      // ce mode aurait pu accorder.
      return ["--approval-mode", "auto-edit"]
    default:
      // `default` demande. Sans personne pour répondre, demander est une
      // attente infinie : mieux vaut un mode qui ne peut rien casser.
      return canAsk ? ["--approval-mode", "default"] : ["--approval-mode", "plan"]
  }
}

/** L'adresse de la passerelle et le nom de la variable qui porte son jeton. */
export type GatewayAim = { baseUrl: string; keyVar: string }

/**
 * La variable d'environnement par laquelle codex lit le jeton de la passerelle.
 *
 * Par l'environnement et pas par la ligne de commande, comme la clef d'un
 * fournisseur : `ps` est lisible par tout ce qui tourne sur la machine.
 */
export const GATEWAY_KEY_VAR = "ZYVRO_GATEWAY_KEY"

/**
 * codexAimArgs : déclarer la passerelle comme un fournisseur, et l'élire.
 *
 * `-c` écrit par-dessus `~/.codex/config.toml` sans le toucher : le réglage ne
 * vit que le temps du tour, donc lancer codex à la main dans un terminal
 * continue de parler à son propre compte.
 *
 * `wire_api = "responses"` est le seul accepté par la 0.152.0 — relevé sur le
 * binaire : « `chat` no longer supported ». C'est toute la raison d'être de la
 * passerelle.
 */
export function codexAimArgs(gateway: GatewayAim): string[] {
  return [
    "-c",
    `model_providers.zyvro={name="Zyvro",base_url="${gateway.baseUrl}",wire_api="responses",env_key="${gateway.keyVar}"}`,
    "-c",
    "model_provider=zyvro",
  ]
}

// mimoPermission : le même choix, dit à MiMo Code.
//
// Son agent `plan` est en lecture seule ; son agent par défaut, `build`,
// autorise tout dans le dossier et demande pour ce qui en sort — et en mode
// `run` personne ne peut répondre, donc ce qui demanderait est refusé. C'est
// la promesse de « project » et de « ask » à la fois : rien ne sort du projet.
// « yolo » lève tout, comme chez les autres.
export function mimoPermission(permission: Permission): string[] {
  switch (permission) {
    case "read":
      return ["--agent", "plan"]
    case "yolo":
      return ["--dangerously-skip-permissions"]
    default:
      return []
  }
}

/**
 * mimoConfig : ce que MiMo Code lit dans `MIMOCODE_CONFIG_CONTENT` — les
 * serveurs MCP de ce projet, au format d'opencode.
 *
 * Par l'environnement et pas par un fichier ni la ligne de commande : elle
 * porte le jeton du démon. Vérifié sur le binaire : `mimo mcp list` lit cette
 * variable et tente de joindre le serveur qu'elle déclare. Elle se fond dans la
 * configuration de la personne sans la remplacer.
 */
export function mimoConfig(ctx: McpTarget): string | null {
  const servers = mcpServers(ctx)
  const names = Object.keys(servers)
  if (names.length === 0) return null
  return JSON.stringify({
    mcp: Object.fromEntries(
      names.map((name) => [
        name,
        { type: "remote", url: servers[name].url, headers: servers[name].headers, enabled: true },
      ])
    ),
  })
}

// Les outils de MiMo Code s'appellent comme ceux d'opencode, en minuscules.
// Traduits vers les noms que le panneau sait déjà raconter — « Ran echo hi »
// plutôt que « Ran bash ».
const MIMO_TOOLS: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "MultiEdit",
  grep: "Grep",
  glob: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  task: "Task",
}

// mimoModelsFrom lit `mimo models` : une ligne par modèle, « fournisseur/modèle
// — window 1.05M, compacts at 944K ». Seul le nom compte ; les couleurs du
// terminal, s'il y en a, sont retirées avant.
export function mimoModelsFrom(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const name = /^\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._:\[\]-]+)(?:\s|$)/.exec(raw)?.[1]
    if (name) seen.add(name)
  }
  return [...seen]
}

export function mimoToolName(tool: string): string {
  return MIMO_TOOLS[tool] ?? tool
}

/**
 * mimoUsageIn : ce qu'une étape a coûté, dans `step_finish`.
 *
 * Relevé sur le binaire : `{"tokens":{"input":71,"output":50,"reasoning":22,
 * "cache":{"read":25536,"write":0}},"cost":0.0001016}`. Comme chez claude,
 * `input` est l'entrée neuve et le cache est compté à part ; le raisonnement,
 * lui, n'est pas dans `output`. Un tour fait de plusieurs étapes les additionne
 * — c'est l'appelant qui cumule.
 */
export function mimoUsageIn(event: Record<string, unknown>): Spent | null {
  const part = event.part as { tokens?: Record<string, unknown>; cost?: unknown } | undefined
  const tokens = part?.tokens
  if (!tokens || typeof tokens !== "object") return null
  const cache = (tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {}) as Record<string, unknown>
  const cacheRead = count(cache.read)
  const cacheWrite = count(cache.write)
  const input = count(tokens.input) + cacheRead + cacheWrite
  const output = count(tokens.output) + count(tokens.reasoning)
  if (input + output === 0) return null
  const cost = typeof part?.cost === "number" && Number.isFinite(part.cost) ? part.cost : null
  return { input, output, cacheRead, cacheWrite, costUsd: cost, context: input }
}

export function addSpent(a: Spent | null, b: Spent): Spent {
  if (!a) return b
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    // Le contexte se prend sur l'étape la plus fraîche : c'est elle qui a
    // relu la conversation entière. Additionner gonflerait la fenêtre.
    context: b.context ?? a.context,
  }
}

// aimArgs pointe Qwen Code sur un serveur que ce projet connaît déjà.
//
// Le modèle et l'adresse sortent du même choix — « lmstudio/qwen3-coder-next »
// nomme les deux — parce que les tenir séparés laisserait exister l'état « le
// modèle de LM Studio, demandé à Ollama », qui répond 404 et n'apprend rien.
//
// Ce qui n'est PAS ici : l'adresse et la clef. Elles passent par
// l'environnement, `aimEnv` — une clef sur la ligne de commande se lit dans
// `ps`, pour tout ce qui tourne sur la machine. Le nom du modèle, lui, n'est
// pas un secret et reste visible, ce qui aide quand on regarde ce que fait
// l'application.
export function aimArgs(aim: Aim): string[] {
  return ["--auth-type", "openai", "-m", aim.model]
}

// aimEnv est l'autre moitié : ce que Qwen Code lit dans son environnement.
//
// Vérifié à la sonde plutôt que supposé — avec ces deux variables et aucun
// drapeau d'adresse, la CLI poste bien sur `/v1/chat/completions` avec
// `Authorization: Bearer …`.
export function aimEnv(aim: Aim): Record<string, string> {
  return {
    OPENAI_BASE_URL: aim.url,
    // Un serveur local n'en demande pas, mais le client en exige une : sans
    // valeur, Qwen Code réclame une connexion au lieu d'appeler.
    OPENAI_API_KEY: aim.key.trim() || "local",
  }
}

/**
 * shellArgsFor : le même harnais, mais dans son interface à lui.
 *
 * Le panneau lance ces CLI en mode impression — `claude -p`, `codex exec` — et
 * lit leur flux JSON pour le redessiner. C'est ce qu'il faut pour tenir une
 * conversation dans une fenêtre qui est la nôtre. Mais ces programmes ont leur
 * propre interface, qui est bonne, et certaines personnes la préfèrent : ce
 * bouton ouvre un shell et la lance dedans, dans le même dossier, avec les
 * mêmes serveurs MCP et le même modèle que le panneau aurait utilisés.
 *
 * Donc : pas de `-p`, pas de `--output-format`, pas de `--append-system-prompt`.
 * Rien de ce qui sert à parler à un programme plutôt qu'à quelqu'un. Ce qui
 * reste est le modèle, et la visée quand il y en a une.
 *
 * La permission, elle, est levée d'office : ce shell sert à confier un projet
 * entier à un agent, et une CLI qui s'arrête à chaque commande pour demander
 * l'autorisation défait l'intérêt de l'avoir lancée. C'est le mode « YOLO » —
 * `SHELL_YOLO` — et il ne touche que les boutons du terminal : les tours du panneau gardent
 * la permission qu'on leur a choisie.
 */
// Défini à côté de la ligne tapée par l'autre bouton, pour que les deux
// ouvertures dans un terminal ne divergent jamais.
export { SHELL_YOLO }

export function shellArgsFor(
  kind: AgentKind,
  model: string | null,
  aim: Aim | null = null,
  gateway: GatewayAim | null = null,
  // La session de la CLI à reprendre, quand le shell continue une conversation
  // du panneau. Vérifiée par l'appelant : elle part sur la ligne de commande.
  resume: string | null = null
): string[] {
  const pinned = model?.trim() ? model.trim() : null
  if (kind === "claude") {
    // La route de la passerelle EST le nom du modèle, comme pour un tour du
    // panneau : claude le renvoie tel quel dans son corps de requête.
    return [...SHELL_YOLO.claude, ...(pinned ? ["--model", pinned] : []), ...(resume ? ["--resume", resume] : [])]
  }
  if (kind === "qwen") {
    return [...(aim ? aimArgs(aim) : pinned ? ["-m", pinned] : []), ...(resume ? ["--resume", resume] : [])]
  }
  if (kind === "mimo") {
    return [...SHELL_YOLO.mimo, ...(pinned ? ["--model", pinned] : []), ...(resume ? ["--session", resume] : [])]
  }
  // codex : `codex resume [OPTIONS] [SESSION_ID]`.
  return [
    ...(resume ? ["resume"] : []),
    ...SHELL_YOLO.codex,
    ...(aim && gateway ? codexAimArgs(gateway) : []),
    ...(pinned ? ["--model", pinned] : []),
    ...(resume ? [resume] : []),
  ]
}

/**
 * claudeAimEnv : par où claude atteint le fournisseur visé.
 *
 * Trois variables, et pas un drapeau : Claude Code n'a aucune option de ligne
 * de commande pour son point d'accès, et une clef sur la ligne de commande se
 * lirait dans `ps` pour tout ce qui tourne sur la machine.
 *
 * **L'adresse est sans `/v1`.** Relevé à la sonde : avec
 * `ANTHROPIC_BASE_URL=http://127.0.0.1:PORT`, la CLI poste sur
 * `/v1/messages?beta=true` — elle ajoute le préfixe elle-même. Lui donner
 * l'adresse que codex reçoit ferait un `/v1/v1/messages` que rien ne sert.
 *
 * **`ANTHROPIC_AUTH_TOKEN` et non `ANTHROPIC_API_KEY`** : la seconde fait
 * basculer la CLI sur une authentification par clef d'API, avec le compte qui
 * va avec. La première est ce qu'elle met dans `Authorization: Bearer`, ce que
 * la passerelle attend.
 *
 * **Deux variables et pas trois** : le modèle reste sur `--model`, que
 * `argsFor` pose déjà. Vérifié de bout en bout — la CLI écrit une mise en garde
 * « unrecognized_model » pour un nom qu'elle ne connaît pas, puis envoie ce nom
 * tel quel dans son corps de requête, ce qui est tout ce dont la passerelle a
 * besoin pour router. La mise en garde est du bruit, pas un refus.
 */
export function claudeAimEnv(origin: string, token: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: token }
}

// directoriesOf is the set of folders a batch of images sits in, without
// repeats — one --add-dir per folder rather than per file.
function directoriesOf(files: string[]): string[] {
  return [...new Set(files.map((file) => path.dirname(file)))]
}

// promptWith is how images reach claude, which has no flag for them.
//
// It reads an image by path with its Read tool — verified against the binary:
// asked to read a logo from a path, it used Read and described the picture. So
// the paths are named in the message, with an instruction plain enough that it
// reads them before answering rather than talking about the filenames.
//
// codex gets nothing added here: it takes the same images as `-i` arguments,
// and repeating them in the text would make it describe a list of paths.
export function promptWith(kind: AgentKind, prompt: string, images: string[]): string {
  // Les deux harnais à enveloppe claude lisent une image par son chemin, avec
  // leur outil de lecture ; codex en prend une par `-i` et n'a rien à lire dans
  // le texte.
  if (harness(kind).envelope !== "claude" || images.length === 0) return prompt
  const listed = images.map((file) => `- ${file}`).join("\n")
  return `${prompt}\n\nThe user attached ${images.length === 1 ? "this image" : "these images"}. Read ${images.length === 1 ? "it" : "them"} with the Read tool before answering:\n${listed}`
}

// modelIn reads which model actually ran, out of the CLI's own init event.
//
// Shown rather than assumed, because the default is the CLI's to choose and it
// changes without asking us: a picker that printed a name of our own would be
// telling the person something we do not know. Claude puts it on the `system`
// init event; the `result` event keys its usage by the same name.
export function modelIn(event: Record<string, unknown>): string | null {
  const value = event.model
  if (typeof value === "string" && value.trim()) return value.trim()
  const usage = event.modelUsage
  if (usage && typeof usage === "object") {
    const [first] = Object.keys(usage as Record<string, unknown>)
    if (first) return first
  }
  return null
}

// Ce qu'un tour a dépensé.
//
// Les chiffres arrivent tout seuls, dans l'événement `result` que claude émet à
// la fin : rien n'est demandé en plus, et il n'y a donc rien à payer pour les
// afficher.
//
// Ce qui mérite attention, c'est le mot « entrée ». Avec le cache de prompt,
// `input_tokens` vaut deux ou trois : ce sont les jetons frais, ceux que le
// modèle n'avait jamais vus. Le reste du contexte — dix mille, trente mille —
// arrive par `cache_read_input_tokens`, et ce qui vient d'être mis en cache par
// `cache_creation_input_tokens`. Afficher `input_tokens` seul annoncerait « 2 »
// pour un tour qui en a fait traverser vingt-sept mille. Les trois sont donc
// additionnés pour l'entrée, et gardés séparément pour qui veut savoir d'où ça
// vient — la lecture de cache ne coûte pas le même prix que le reste.
//
// Codex n'est pas lu ici. Son flux n'a jamais pu être observé sur cette
// machine : le CLI installé refuse son propre modèle par défaut et demande une
// mise à jour. Écrire un analyseur pour une forme qu'on n'a pas vue, c'est
// écrire du code qui a l'air de marcher.
export type Spent = {
  /** Les jetons d'entrée, cache compris : ce que le tour a fait traverser. */
  input: number
  output: number
  /** Relu depuis le cache — la part la moins chère de l'entrée. */
  cacheRead: number
  /** Écrit dans le cache pour les tours suivants. */
  cacheWrite: number
  /** Ce que le CLI en dit, quand il le dit. Null sur un abonnement. */
  costUsd: number | null
  /**
   * Jetons dans le contexte après ce tour — pas la somme des étapes.
   *
   * Un tour à plusieurs étapes (mimo) additionne ses coûts, pas ses
   * contextes : à chaque étape le modèle relit tout, et additionner
   * compterait la même conversation plusieurs fois. C'est la dernière
   * mesure qui dit où en est la fenêtre.
   */
  context?: number
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * usageIn : ce qu'un tour a coûté, dans l'enveloppe de claude — et de qwen, qui
 * imprime la même. Lu sur l'événement `result`.
 *
 * Chez eux, `input_tokens` est l'entrée NEUVE : ce qui vient du cache est
 * compté à part. Le total traversé est donc la somme des trois.
 */
export function usageIn(event: Record<string, unknown>): Spent | null {
  const usage = event.usage
  if (!usage || typeof usage !== "object") return null
  const u = usage as Record<string, unknown>

  const fresh = count(u.input_tokens)
  const cacheWrite = count(u.cache_creation_input_tokens)
  const cacheRead = count(u.cache_read_input_tokens)
  const output = count(u.output_tokens)
  // Un événement sans un seul jeton n'est pas une dépense : ne rien afficher
  // vaut mieux qu'afficher des zéros sous chaque réponse.
  if (fresh + cacheWrite + cacheRead + output === 0) return null

  const cost = event.total_cost_usd
  const total = fresh + cacheWrite + cacheRead
  return {
    input: total,
    output,
    cacheRead,
    cacheWrite,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    // Un seul appel, toute la conversation : l'entrée EST le contexte.
    context: total,
  }
}

/**
 * codexUsageIn : la même chose dans l'enveloppe de codex, qui ne dit rien
 * pareil. Lu sur `turn.completed`.
 *
 * Le panneau n'a jamais montré de reçu pour codex, et la note disait que ça
 * viendrait tout seul « le jour où il tourne — elle lit le même champ ». Elle
 * avait tort deux fois : `usageIn` n'est appelée que sur `result`, que codex
 * n'émet pas, et les noms diffèrent. Relevé sur un vrai tour :
 *
 *   {"type":"turn.completed","usage":{"input_tokens":52580,
 *    "cached_input_tokens":0,"cache_write_input_tokens":0,
 *    "output_tokens":417,"reasoning_output_tokens":0}}
 *
 * Deux pièges dans ces cinq nombres :
 *
 * · **`input_tokens` est le TOTAL**, pas l'entrée neuve — c'est la convention
 *   d'OpenAI, où les jetons relus du cache sont un détail de ce total. Les
 *   additionner comme on le fait pour claude compterait le cache deux fois et
 *   gonflerait la facture affichée.
 * · **`reasoning_output_tokens` est déjà dans `output_tokens`**, pour la même
 *   raison. L'ajouter doublerait la sortie d'un modèle qui réfléchit.
 *
 * Aucun des deux ne se voit sur un serveur local, qui ne met rien en cache :
 * ils sont restés à zéro sur tous les tours mesurés ici. C'est justement
 * pourquoi la règle est écrite plutôt que devinée plus tard.
 */
export function codexUsageIn(event: Record<string, unknown>): Spent | null {
  const usage = event.usage
  if (!usage || typeof usage !== "object") return null
  const u = usage as Record<string, unknown>

  const total = count(u.input_tokens)
  const cacheRead = Math.min(count(u.cached_input_tokens), total)
  const cacheWrite = count(u.cache_write_input_tokens)
  const output = count(u.output_tokens)
  if (total + output === 0) return null

  return {
    input: total,
    output,
    cacheRead,
    cacheWrite,
    // codex ne chiffre pas ses tours : il tourne sur un abonnement, ou — ici —
    // sur un serveur local qui ne facture rien.
    costUsd: null,
    // Chez OpenAI `input_tokens` est le total, cache compris : le contexte.
    context: total,
  }
}

// aliasesFrom pulls the model aliases out of a CLI's own --help text.
//
// There is no machine-readable list to ask for — neither CLI has one — so the
// choice was between writing the names down here and reading them where the
// tool states them. Written down, they would be a second list: a new alias
// would appear in the CLI and never in this menu, and one that went away would
// stay in it and fail.
//
// The parse is deliberately narrow, and a parse that finds nothing is not a
// failure: the picker then offers the default and a box to type a name in,
// which is what it offers anyway for a full model name.
export function aliasesFrom(help: string): string[] {
  const sentence = /alias[^.]*?\(e\.g\.([^)]*)\)/is.exec(help)
  if (!sentence) return []
  return [...sentence[1].matchAll(/'([a-z0-9][a-z0-9.-]*)'/gi)].map((m) => m[1])
}

// sessionIn reads the CLI's own id for the conversation out of one event.
//
// The two call it different things — claude `session_id`, codex `thread_id` —
// and that was read out of their real output, not assumed. Guessing it wrong
// costs nothing visible: resume simply never happens, and the agent is
// amnesiac again with no error to explain it.
export function sessionIn(event: Record<string, unknown>): string | null {
  // MiMo Code, comme opencode : `sessionID`, sur chaque événement.
  const value = event.session_id ?? event.thread_id ?? event.sessionID
  return typeof value === "string" && value ? value : null
}

// Ce qu'on garde d'un tour pour pouvoir le rejouer. Deux mégaoctets : une
// réponse ordinaire en fait quelques dizaines de milliers, et un tour qui
// dépasse ça a de toute façon plus de sortie qu'un écran n'en montre.
const REPLAY_MAX_BYTES = 2 * 1024 * 1024

type Turn = {
  id: string
  conversationId: string
  /** Quand le tour a été lancé (ms) : une fenêtre rechargée en plein tour
   *  reprend la durée là où elle en était, pas à zéro. */
  startedAt: number
  /**
   * Le projet où ce tour tourne. Une fenêtre tient plusieurs projets, et un
   * tour du projet A ne doit pas réapparaître dans le chat du projet B quand
   * celui-ci se raccroche aux tours en vol.
   */
  projectDir: string
  /** Ce que les étapes du tour ont coûté jusqu'ici — MiMo Code les compte une à une. */
  spent?: Spent | null
  /**
   * Ce qui a été demandé, mot pour mot.
   *
   * Retenu pour pouvoir redessiner la question après un rechargement du rendu :
   * un tour en vol n'est pas encore écrit sur le disque — le transcript n'est
   * enregistré qu'à la fin — donc personne d'autre ne l'a.
   */
  prompt: string
  /**
   * Les lignes que la CLI a déjà imprimées, pour les rejouer à une fenêtre qui
   * s'est rechargée pendant le tour.
   *
   * Les lignes BRUTES, et pas les événements qu'on en a tirés : elles
   * repasseront par le même analyseur, donc une reprise montre exactement ce
   * qu'un tour normal aurait montré. Deux chemins de lecture finiraient par
   * diverger, et la différence ne se verrait que le jour d'une reprise.
   */
  lines: string[]
  /** La taille du tampon, pour le borner sans compter à chaque fois. */
  bytes: number
  // Quel harnais tourne : c'est lui que la session apprise concerne.
  kind: AgentKind
  // Ce que ce tour a demandé pour la suite, lu au vol et honoré à la fin : au
  // milieu, il peut encore changer d'avis.
  wake: Wake | null
  child: ChildProcess
  // Whether any assistant text has gone out for this turn yet. The CLI emits
  // one assistant message per stretch of thinking, and between two of them
  // there is usually a tool call. Concatenating them verbatim runs the last
  // sentence of one into the first word of the next.
  sentText: boolean
  cancel?: () => void
  complete?: () => void
  /**
   * Glisser un message dans ce tour pendant qu'il tourne. Absent pour les
   * harnais qui ne savent pas (qwen, MiMo) : leurs messages attendent la fin
   * du tour, dans la file de la fenêtre.
   */
  steer?: (text: string) => Promise<boolean>
  /** Claude : les messages écrits pas encore repris, et les reprises vues. */
  live?: { pending: number; replays: number; closer: ReturnType<typeof setTimeout> | null }
}

// Each turn has its own process group. Stop must reach tools/MCP children too,
// and SIGTERM is only a request: a stuck CLI must eventually receive SIGKILL.
function stopProcess(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    killer.on("error", () => { child.kill("SIGKILL") })
    return
  }
  const signal = (name: NodeJS.Signals): void => {
    try { process.kill(-pid, name) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") console.error("[agent] stop:", err)
    }
  }
  signal("SIGTERM")
  // Keep this even if the parent exits: a tool in its group may ignore SIGTERM.
  setTimeout(() => signal("SIGKILL"), 1500).unref()
}

/** Une question à Claude en `--input-format stream-json` : une ligne JSON. */
export function claudeUserLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`
}

/** Le texte d'une question renvoyée par `--replay-user-messages`. */
export function replayText(event: Record<string, unknown>): string {
  const message = event.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("")
}

/** Les paires `-c clé=valeur` d'une ligne de commande, dans l'ordre. */
export function configPairs(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-c") {
      out.push("-c", args[i + 1])
      i++
    }
  }
  return out
}

// Le serveur d'application de codex est-il là ? Demandé une fois par binaire :
// une version qui ne l'a pas garde `codex exec`, sans glissement en plein tour.
// `ZYVRO_CODEX_EXEC=1` force exec, pour comparer ou contourner.
const serveurs = new Map<string, boolean>()
export function codexServerReady(bin: string): boolean {
  if (process.env.ZYVRO_CODEX_EXEC === "1") return false
  const connu = serveurs.get(bin)
  if (connu !== undefined) return connu
  let ok = false
  try {
    const r = spawnSync(bin, ["app-server", "--help"], { timeout: 10_000, windowsHide: true, encoding: "utf8", shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(bin) })
    ok = r.status === 0 && /generate-json-schema|app server/i.test(`${r.stdout}${r.stderr}`)
  } catch {
    ok = false
  }
  serveurs.set(bin, ok)
  return ok
}

export class AgentRunner {
  private turns = new Map<string, Turn>()

  // The CLI's own id for each conversation, learned from its output stream.
  //
  // This is what makes the agent remember. Without it every message opened a
  // fresh process that knew nothing of the one before: the panel showed a
  // conversation, and the CLI was answering a series of unrelated questions.
  // "Add a function" then "now the tests" got a puzzled answer about tests in
  // general, and nothing in the window explained why.
  //
  // Held here and handed back to the caller, which is what writes it down: this
  // class knows how to talk to a CLI and should not also own a file.
  // Une session par conversation ET par harnais.
  //
  // Elle appartient au harnais, pas à la conversation, et les tenir ensemble
  // était un vrai défaut — trouvé en s'en servant, pas en relisant : une
  // conversation commencée avec claude, basculée sur qwen, lançait
  // `qwen --resume <identifiant de claude>`. Qwen Code répond alors « No saved
  // session found with ID … », et c'est la réponse qui remplace le tour.
  //
  // Basculer d'un harnais à l'autre repart donc de zéro chez le nouveau, et
  // revenir au premier retrouve son fil. C'est ce que « changer d'agent »
  // devrait vouloir dire.
  // Le dernier but connu de chaque conversation, pour ne prévenir la fenêtre
  // que quand il bouge.
  private goals = new Map<string, Goal>()

  // Ce qu'il faut pour refaire un tour de cette conversation sans que personne
  // ne tape : où l'envoyer, avec quel harnais, dans quel projet, sur quel
  // modèle. Retenu au moment de l'envoi plutôt que reconstruit plus tard —
  // reconstruire, ce serait deviner, et un réveil qui repart sur le mauvais
  // modèle n'a aucune raison d'être remarqué.
  private repeats = new Map<string, { target: WebContents; kind: AgentKind; ctx: AgentContext; model: string | null; aim: Aim | null }>()

  // La passerelle Responses, une par fenêtre et allumée à la demande.
  //
  // Une par fenêtre et pas une par tour : ouvrir une socket pour la fermer
  // trois secondes plus tard, c'est un port neuf à chaque message et une course
  // le jour où deux tours partent ensemble. Elle route sur le nom du modèle,
  // donc deux sessions visant deux fournisseurs y tiennent sans se mélanger.
  private gateway: GatewayHandle | null = null

  // Les réveils armés, par conversation. En mémoire : une boucle vit tant que
  // la fenêtre vit, ce qui est déjà infiniment plus que « tant que le processus
  // du tour vit », et ce que promet le panneau — une session en cours, avec de
  // quoi l'arrêter.
  private waking = new Map<string, { timer: NodeJS.Timeout; pending: Pending }>()

  private sessions = new Map<string, string>()

  private static key(kind: AgentKind, conversationId: string): string {
    return `${kind}\u0000${conversationId}`
  }

  // sessionFor is what the panel's persistence reads after a turn.
  sessionFor(kind: AgentKind, conversationId: string): string | null {
    return this.sessions.get(AgentRunner.key(kind, conversationId)) ?? null
  }

  // sessionsFor rend tout ce qui est connu d'une conversation, harnais par
  // harnais : c'est ce qui est écrit sur le disque, pour qu'un fil repris
  // demain le soit chez le bon.
  sessionsFor(conversationId: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const kind of AGENT_KINDS) {
      const id = this.sessionFor(kind, conversationId)
      if (id) out[kind] = id
    }
    return out
  }

  // resumeAt seeds a session learned in a previous run of the app, so a
  // conversation reopened tomorrow carries on rather than starting over.
  resumeAt(kind: AgentKind, conversationId: string, sessionId: string | null): void {
    const key = AgentRunner.key(kind, conversationId)
    if (sessionId) this.sessions.set(key, sessionId)
    else this.sessions.delete(key)
  }

  // forget efface tout ce qu'on sait d'une conversation, chez tous les harnais.
  forget(conversationId: string): void {
    for (const kind of AGENT_KINDS) this.resumeAt(kind, conversationId, null)
  }

  available(kind: AgentKind): string {
    return harness(kind).bin
  }

  // installed is what the panel asks before offering the agent at all, and it
  // asks cli.ts rather than the PATH directly: on Windows the thing called
  // `claude` is `claude.cmd`, and a check that only looked for `claude` would
  // report it missing on a machine where it works.
  installed(kind: AgentKind): boolean {
    return cliInstalled(this.available(kind))
  }

  /**
   * openGateway prépare la route par laquelle codex atteindra un fournisseur.
   *
   * Appelée avant `send` parce que `send` est synchrone et qu'ouvrir une
   * socket ne l'est pas : le port doit être connu au moment où l'on écrit la
   * ligne de commande. C'est l'appelant — la couche IPC, qui est déjà
   * asynchrone — qui l'attend.
   *
   * Rien ne s'allume pour un harnais qui n'en a pas besoin : une fenêtre qui ne
   * se sert que de claude n'ouvre jamais ce serveur.
   */
  /**
   * La passerelle allumée, si elle l'est.
   *
   * Rendue plutôt que gardée privée parce qu'un shell ouvert sur un harnais en
   * a besoin des mêmes trois choses que `send` : l'adresse pour codex,
   * l'origine pour claude, le jeton pour les deux. La rendre en entier plutôt
   * qu'en recopier trois champs — c'est le même objet, et deux idées de ce
   * qu'il contient finiraient par diverger.
   */
  gatewayAim(): GatewayHandle | null {
    return this.gateway
  }

  async openGateway(kind: AgentKind, aim: Aim, key: string): Promise<void> {
    if (!harness(kind).gateway) return
    if (!this.gateway) this.gateway = await startGateway()
    this.gateway.aim(key, aim)
  }

  // send starts one turn and streams it back.
  //
  // Each turn is still a fresh process — `claude -p` and `codex exec` are
  // one-shot by design — but it is no longer a fresh conversation: both CLIs
  // can pick up a previous session by id, and that id is what turns a row of
  // separate questions into a thread.
  send(
    target: WebContents,
    kind: AgentKind,
    prompt: string,
    ctx: AgentContext,
    conversationId: string,
    model: string | null = null,
    images: string[] = [],
    // Où ce harnais va chercher son modèle, quand ce n'est pas son propre
    // compte. Résolu par l'appelant : c'est lui qui peut demander au moteur
    // quels serveurs ce projet a allumés.
    aim: Aim | null = null
  ): string {
    const id = randomUUID()
    this.repeats.set(conversationId, { target, kind, ctx, model, aim })
    const resume = this.sessionFor(kind, conversationId)
    const bin = this.available(kind)
    const env: NodeJS.ProcessEnv = { ...process.env }
    let disposeConfig: (() => void) | null = null

    const passerelle =
      harness(kind).gateway && aim && this.gateway
        ? { baseUrl: this.gateway.baseUrl, keyVar: GATEWAY_KEY_VAR }
        : null
    const args: string[] = argsFor(kind, ctx, resume ?? null, model, images, aim, passerelle)
    // La clef du point d'accès arrive ici et pas dans `args` : la table des
    // processus est lisible par tout ce qui tourne sur cette machine.
    //
    // Et seulement pour qui les lit : `OPENAI_BASE_URL` est ce que Qwen Code
    // attend. codex, lui, passe par la passerelle et lit son jeton à elle —
    // lui poser en plus l'adresse d'un fournisseur serait un second chemin
    // vers le même serveur, c'est-à-dire celui des deux qui aura tort.
    if (aim && kind === "qwen") Object.assign(env, aimEnv(aim))
    // claude lit son point d'accès dans l'environnement, comme qwen, mais c'est
    // la passerelle qu'il y trouve et pas le fournisseur : il ne sait pas
    // parler Chat Completions. `--model` porte déjà le nom visé, qui est la
    // route — voir argsFor.
    if (passerelle && kind === "claude" && this.gateway) {
      Object.assign(env, claudeAimEnv(this.gateway.origin, this.gateway.token))
    }
    if (passerelle && this.gateway) env[GATEWAY_KEY_VAR] = this.gateway.token

    if (mcpAvailable(ctx)) {
      if (kind === "claude") {
        const config = claudeMcpConfig(ctx)
        disposeConfig = config.dispose
        args.push(
          "--mcp-config",
          config.path,
          // Add Zyvro to the user's MCP configuration, preserving their integrations.
          // A print-mode run cannot prompt for permission, so the Zyvro tools
          // are pre-approved. Nothing else is: the CLI's own file and shell
          // tools keep whatever policy the user configured.
          "--allowedTools",
          // La capture est pré-accordée comme le reste : elle ne peut voir que
          // la fenêtre de l'application, et un tour en mode impression ne peut
          // demander la permission à personne.
          // Les serveurs réellement déclarés dans le fichier, et eux seuls :
          // pré-accorder un outil absent ne coûte rien, mais en oublier un
          // rendrait « permission refusée » pour un outil qu'on vient d'offrir.
          Object.keys(mcpServers(ctx))
            .map((name) => `mcp__${name}`)
            .join(",")
        )
      } else if (kind === "qwen") {
        // Le même fichier de configuration, deux drapeaux à lui. Qwen Code
        // écrit `--allowed-tools` avec des tirets là où claude écrit
        // `--allowedTools`, et nomme les serveurs permis séparément. Ce sont
        // les noms lus dans son `--help`, pas les noms devinés depuis l'autre :
        // un drapeau mal orthographié n'est pas refusé, il est ignoré, et les
        // outils de Zyvro manquent sans que rien ne le dise.
        const config = claudeMcpConfig(ctx, "qwen")
        disposeConfig = config.dispose
        const servers = Object.keys(mcpServers(ctx))
        args.push(
          "--mcp-config",
          config.path,
          "--allowed-mcp-server-names",
          ...servers,
          "--allowed-tools",
          ...servers.map((name) => `mcp__${name}`)
        )
      } else if (kind === "mimo") {
        // MiMo Code lit ses serveurs MCP dans son environnement — jeton
        // compris, et donc hors de la table des processus.
        const config = mimoConfig(ctx)
        if (config) env.MIMOCODE_CONFIG_CONTENT = config
      } else {
        // Codex reads the token from the environment rather than from a flag,
        // which keeps it out of the process table.
        Object.assign(env, mcpTokenEnv(ctx))
        args.push(...codexMcpArgs(ctx))
      }
    }

    if (speaksCodex(kind)) args.push("-")

    const userText = promptWith(kind, prompt, images)
    // Keep native slash commands intact. The catalog travels over stdin, not
    // argv: a large installation must not exceed the OS argument limit.
    const withImages = promptWithSkills(userText, ctx.skills, ctx.advancedSkills)
    // Ni codex ni MiMo Code n'ont de drapeau de prompt système : le préambule
    // ouvre la question.
    const text = harness(kind).envelope !== "claude" ? `${preamble(ctx)}\n\n---\n\n${withImages}` : withImages

    // launch rather than spawn: it resolves the real file, which on Windows
    // carries an extension and may be a .cmd that Node refuses to start
    // without a shell.
    // La commande d'installation vient de la table des harnais, qui la porte
    // déjà : l'écrire une seconde fois dans le message d'erreur serait la
    // deuxième liste qui a tort le jour où le paquet change de nom.
    //
    // Codex passe par son serveur d'application quand il l'a : c'est lui qui
    // sait recevoir un message en plein tour (main/codexserver.ts). Les mêmes
    // réglages `-c` que pour exec — MCP, passerelle, bac à sable —, la
    // question en entrée JSON-RPC plutôt que sur stdin.
    const serveur = kind === "codex" && codexServerReady(bin)
    const child = launchPiped(bin, serveur ? ["app-server", ...CODEX_QUESTIONS_FEATURE, ...configPairs(args)] : args, { cwd: ctx.projectDir, env, detached: process.platform !== "win32" }, harness(kind).install)
    const turn: Turn = { id, conversationId, startedAt: Date.now(), projectDir: ctx.projectDir, kind, prompt: prompt, lines: [], bytes: 0, wake: null, child, sentText: false }
    this.turns.set(id, turn)

    // Ce que la sortie du processus devient : des événements au format du
    // harnais, sauf pour le serveur de codex, qui parle JSON-RPC et que son
    // pilote traduit.
    let settled = false
    let onLine = (line: string): void => {
      if (settled) return
      this.remember(id, line)
      this.emitEvent(target, id, kind, line)
    }
    let serverTurn: CodexServerTurn | null = null
    let exitTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (message?: string): void => {
      if (settled) return
      settled = true
      this.turns.delete(id)
      if (turn.live?.closer) clearTimeout(turn.live.closer)
      serverTurn?.closed()
      disposeConfig?.()
      disposeConfig = null
      if (!target.isDestroyed()) {
        if (message) this.sendError(target, { id, message })
        else target.send("agent:done", { id })
      }
    }
    turn.cancel = () => {
      if (settled) return
      this.unschedule(conversationId)
      finish()
      child.stdin.destroy()
      stopProcess(child)
    }
    turn.complete = () => {
      if (settled) return
      if (!child.stdin.writableEnded) child.stdin.end()
      finish()
      // A final protocol result ends the UI turn. Give hooks/MCP teardown time
      // to finish, but don't leave a process alive indefinitely afterwards.
      exitTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) stopProcess(child)
      }, 3000)
      exitTimer.unref()
    }
    child.stdin.on("error", (err: Error) => {
      if (settled) return
      finish(`Could not send input to ${bin}: ${err.message}`)
      stopProcess(child)
    })
    if (serveur) {
      const pilote = new CodexServerTurn(
        (line) => {
          if (!child.stdin.writableEnded) child.stdin.write(`${line}\n`)
        },
        (event) => {
          if (settled || target.isDestroyed()) return
          const line = JSON.stringify(event)
          this.remember(id, line)
          this.emitEvent(target, id, kind, line)
        },
        () => turn.complete?.(),
        // Ses questions vont à la fenêtre du tour, celle qui l'a lancé.
        async (questions, signal) => {
          if (target.isDestroyed()) return null
          const answer = await askIn(target, { tool: "request_user_input", input: {}, questions }, signal)
          return answer.allow ? answer.answers ?? null : null
        }
      )
      serverTurn = pilote
      onLine = (line) => { if (!settled) pilote.onLine(line) }
      turn.steer = (message) => pilote.steer(message)
      const pinned = model?.trim() ? model.trim() : null
      void pilote.start({
        cwd: ctx.projectDir,
        model: pinned,
        ...codexServerPolicy(ctx.permission ?? DEFAULT_PERMISSION),
        resume: resume ?? null,
        input: codexInput(text, images),
      })
    } else if (kind === "claude") {
      // L'entrée reste ouverte : c'est par là qu'un message glissé arrive. Elle
      // se ferme au résultat, quand plus rien n'attend (voir emitEvent).
      child.stdin.write(claudeUserLine(text))
      turn.live = { pending: 0, replays: 0, closer: null }
      turn.steer = async (message) => {
        if (child.stdin.writableEnded || !this.turns.has(id)) return false
        child.stdin.write(claudeUserLine(message))
        turn.live!.pending++
        return true
      }
    } else {
      child.stdin.write(text)
      child.stdin.end()
    }

    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (settled) return
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) onLine(line)
        index = buffer.indexOf("\n")
      }
    })

    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ENOENT"
        ? `"${bin}" is not on your PATH. Install it and sign in, then reopen this panel.`
        : err.message)
    })

    child.on("exit", (code, signal) => {
      if (exitTimer) clearTimeout(exitTimer)
      // Drain the last protocol line before removing its turn/session state.
      if (!settled && buffer.trim()) onLine(buffer.trim())
      finish(code === 0 ? undefined : stderr.trim() || `${bin} exited with ${signal ?? `code ${code}`}`)
    })

    return id
  }

  // emitEvent normalizes the two CLIs' stream formats into one shape. Neither
  // format is contractual, so anything unrecognized is forwarded as raw text
  // rather than dropped: a silent panel is worse than an ugly one.
  // honorWake tient ce que le tour a demandé.
  //
  // C'est ici que « le tour ne se termine pas quand le processus sort » devient
  // vrai : le processus sort bel et bien — c'est sa nature, `-p` est un
  // aller-retour — mais la session, elle, a un rendez-vous.
  private honorWake(turn: Turn): void {
    const demande = turn.wake
    if (!demande) return
    turn.wake = null
    if (demande.stop === true) {
      this.unschedule(turn.conversationId)
      return
    }
    // Le cron voyage avec le rendez-vous : le prochain passage se recalcule à
    // chaque fois, sinon tous les suivants dérivent de la durée du premier tour.
    this.schedule(turn.conversationId, demande.delaySeconds, demande.prompt, demande.recurring ? demande.cron ?? null : null)
  }

  // schedule arme un réveil, et n'en arme jamais deux.
  //
  // Un tour qui redemande écrase le précédent : deux minuteries pour une
  // conversation, c'est la boucle qui se dédouble à chaque passage, et la
  // troisième fois personne ne comprend pourquoi l'agent répond quatre fois.
  private schedule(conversationId: string, delaySeconds: number, prompt: string, cron: string | null): void {
    const repeat = this.repeats.get(conversationId)
    if (!repeat || repeat.target.isDestroyed()) return
    this.clearTimer(conversationId)

    const pending: Pending = { conversationId, at: Date.now() + delaySeconds * 1000, prompt, cron }
    const timer = setTimeout(() => {
      this.waking.delete(conversationId)
      const encore = this.repeats.get(conversationId)
      if (!encore || encore.target.isDestroyed()) return
      // Le rythme se réarme avant de partir, et sur la prochaine occurrence
      // recalculée : si le tour dure trois minutes, la minute suivante doit
      // déjà être comptée, sinon « toutes les minutes » veut dire « toutes les
      // quatre minutes » et personne ne l'a demandé.
      const suivant = cron === null ? null : nextRunIn(cron, Date.now())
      if (cron !== null && suivant !== null) {
        this.schedule(conversationId, Math.max(1, Math.round(suivant / 1000)), prompt, cron)
      } else {
        encore.target.send("agent:scheduled", { conversationId, pending: null })
      }
      // La fenêtre doit savoir qu'un tour est parti sans elle.
      //
      // Elle ne dessine une bulle que pour ce qu'ELLE a envoyé : un tour né
      // d'une minuterie n'a pas de message, ses événements arrivent sans
      // destination et sont garés indéfiniment. Vu en éprouvant la boucle — le
      // décompte repartait, de vrais tours tournaient, et l'écran ne bougeait
      // pas d'une ligne. Une boucle invisible qui dépense est pire qu'une
      // boucle qui ne tourne pas.
      const turnId = this.send(encore.target, encore.kind, prompt, encore.ctx, conversationId, encore.model, [], encore.aim)
      encore.target.send("agent:woke", { conversationId, turnId, prompt })
    }, delaySeconds * 1000)
    // Une minuterie ne doit pas retenir le processus : quitter l'application
    // quitte, elle ne s'attarde pas jusqu'au prochain réveil.
    timer.unref?.()

    this.waking.set(conversationId, { timer, pending })
    repeat.target.send("agent:scheduled", { conversationId, pending })
  }

  private clearTimer(conversationId: string): void {
    const en_cours = this.waking.get(conversationId)
    if (!en_cours) return
    clearTimeout(en_cours.timer)
    this.waking.delete(conversationId)
  }

  // unschedule : le bouton d'arrêt, et ce que `stop: true` demande.
  unschedule(conversationId: string): void {
    const avait = this.waking.has(conversationId)
    this.clearTimer(conversationId)
    if (!avait) return
    const repeat = this.repeats.get(conversationId)
    if (repeat && !repeat.target.isDestroyed()) {
      repeat.target.send("agent:scheduled", { conversationId, pending: null })
    }
  }

  // pendingWake : ce qui est armé, pour une fenêtre qui vient de se rouvrir.
  pendingWake(conversationId: string): Pending | null {
    return this.waking.get(conversationId)?.pending ?? null
  }

  // remember garde une ligne pour une reprise éventuelle.
  //
  // Borné en octets : un tour qui imprime longtemps ne doit pas faire grossir
  // le processus principal sans fin. Quand le plafond est atteint on jette par
  // le début — ce qu'on veut retrouver à l'écran après un rechargement est la
  // fin, c'est-à-dire là où le tour en est.
  private remember(id: string, line: string): void {
    const turn = this.turns.get(id)
    if (!turn) return
    turn.lines.push(line)
    turn.bytes += line.length
    while (turn.bytes > REPLAY_MAX_BYTES && turn.lines.length > 1) {
      turn.bytes -= (turn.lines.shift() as string).length
    }
  }

  /**
   * Les tours encore en vol, pour une fenêtre qui vient de se recharger.
   *
   * En développement, `electron-vite` recharge le rendu à chaque fichier
   * modifié. Le processus principal, lui, ne redémarre pas : le tour continue,
   * il dépense, et la page neuve n'a plus aucune idée de son existence. Ses
   * événements arrivaient donc dans le vide — le panneau les garait comme
   * « orphelins » pour toujours, et l'écran ne bougeait plus.
   */
  // Ceux d'un seul projet quand on le nomme : c'est ce que demande le panneau
  // en arrivant sur un projet, et les tours des autres ne sont pas les siens.
  running(projectDir?: string): { id: string; conversationId: string; prompt: string; startedAt: number }[] {
    return [...this.turns.values()].filter((turn) => projectDir === undefined || turn.projectDir === projectDir).map((turn) => ({
      id: turn.id,
      conversationId: turn.conversationId,
      prompt: turn.prompt,
      startedAt: turn.startedAt,
    }))
  }

  /**
   * Rejouer à une fenêtre ce qu'un tour a déjà imprimé.
   *
   * Appelé après que le rendu s'est réaccroché, jamais avant : les événements
   * portent l'identifiant du tour, et une page qui ne l'a pas encore lié les
   * garerait une seconde fois.
   */
  replay(id: string, target: WebContents): void {
    const turn = this.turns.get(id)
    if (!turn || target.isDestroyed()) return
    // Un compteur à lui : rejouer redit les accusés à la fenêtre, à leur
    // place, sans toucher à l'état du tour qui tourne encore.
    const rejeu = { replays: 0 }
    for (const line of turn.lines) this.emitEvent(target, id, turn.kind, line, rejeu)
  }

  private emitEvent(target: WebContents, id: string, kind: AgentKind, line: string, rejeu: { replays: number } | null = null): void {
    if (target.isDestroyed()) return
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      target.send("agent:text", { id, text: line })
      return
    }

    const turn = this.turns.get(id)

    // The session id, wherever it appears. Claude calls it session_id and puts
    // it on every event; codex calls it thread_id — a difference worth reading
    // out of the real output rather than assuming, because guessing it wrong
    // means resume silently never happens and the agent is amnesiac again.
    // Which model actually ran, reported once so the picker can show the CLI's
    // own default instead of a name we made up.
    const ranWith = modelIn(parsed)
    if (turn && ranWith) target.send("agent:model", { id, conversationId: turn.conversationId, model: ranWith })

    // Ce que ce tour demande pour la suite. Retenu et non honoré tout de suite :
    // au milieu d'un tour, il peut encore l'annuler.
    if (turn) {
      const demande = wakeIn(parsed)
      if (demande) turn.wake = demande
    }

    // Le but de la session, quand le harnais en dit quelque chose. Les deux
    // formes sont lues au même endroit ; seul un changement traverse, parce que
    // qwen réémet la sienne à chaque événement du flux.
    const dit = turn ? goalIn(parsed) : null
    if (dit && !sameGoal(this.goals.get(turn!.conversationId) ?? null, dit.goal)) {
      if (dit.goal) this.goals.set(turn!.conversationId, dit.goal)
      else this.goals.delete(turn!.conversationId)
      target.send("agent:goal", { conversationId: turn!.conversationId, goal: dit.goal })
    }

    // Ce que ce harnais sait faire, annoncé par lui à l'ouverture du flux. On
    // le garde : la liste n'arrive qu'avec un tour, et le moment où l'on
    // cherche ce qu'on peut taper est justement celui d'avant.
    const commands = commandsIn(parsed)
    if (commands && rememberCommands(kind, commands)) {
      target.send("agent:commands", { kind, commands })
    }

    const learned = sessionIn(parsed)
    if (turn && learned) {
      if (this.sessionFor(turn.kind, turn.conversationId) !== learned) {
        this.resumeAt(turn.kind, turn.conversationId, learned)
        target.send("agent:session", {
          id,
          conversationId: turn.conversationId,
          kind: turn.kind,
          sessionId: learned,
        })
      }
    }
    const send = (text: string) => {
      if (!text) return
      // A new block starts a new paragraph, which is also what makes the
      // Markdown renderer treat it as one.
      const separator = turn?.sentText ? "\n\n" : ""
      if (turn) turn.sentText = true
      target.send("agent:text", { id, text: separator + text })
    }
    // A tool call and its result are two events, and the result can arrive out
    // of order: two Bash calls running at once come back in whichever finishes
    // first. So they are paired by the call's own id and never by arrival.
    const started = (callId: string, name: string, input: unknown) => {
      const talk = describeTool(name, input)
      target.send("agent:tool", {
        id,
        callId,
        name,
        running: talk.running,
        done: talk.done,
        shape: talk.shape,
        detail: talk.detail,
        plan: talk.shape === "plan" ? planIn(input) : [],
      })
    }
    // Le résultat d'un outil, avec ce qu'il montre.
    //
    // Les images sont écrites à côté de la conversation avant d'être annoncées,
    // pour trois raisons qui vont ensemble : le transcript garde un identifiant
    // et pas quatre mégaoctets de base64 réécrits à chaque sauvegarde ; elles
    // s'effacent avec la conversation, sans balayeur à écrire ; et elles
    // s'affichent par le même chemin que les pièces jointes, donc il n'y a
    // qu'un seul chemin à garder juste.
    //
    // L'écriture est attendue avant l'envoi : deux événements pour un seul
    // résultat obligeraient le rendu à recoller les morceaux, et c'est
    // exactement le genre de recollage qui laisse une image orpheline.
    const finished = (callId: string, content: unknown, isError: boolean) => {
      const output = outputIn(content)
      // Sans le tour on ne sait pas à quelle conversation ces octets
      // appartiennent, donc où les écrire ni quand les effacer. Le texte part
      // quand même : il vaut mieux qu'une moitié de résultat que rien.
      const shown = turn ? imagesIn(content) : []
      if (shown.length === 0) {
        target.send("agent:tool-result", { id, callId, output, isError, images: [] })
        return
      }
      void (async () => {
        const images: { id: string; name: string }[] = []
        for (const [index, image] of shown.entries()) {
          try {
            const kept = await keepImage(turn!.conversationId, `tool-${callId}-${index}`, image.bytes)
            images.push({ id: kept.id, name: kept.name })
          } catch {
            // Une image qu'on ne sait pas garder ne doit pas emporter le
            // résultat : le texte, lui, a toujours sa valeur.
          }
        }
        if (target.isDestroyed()) return
        target.send("agent:tool-result", { id, callId, output, isError, images })
      })()
    }

    // L'enveloppe décide, pas le nom du harnais. Qwen Code imprime exactement
    // celle de Claude Code — mêmes `type`, même `session_id`, même bloc
    // `usage` — et lui écrire un deuxième analyseur serait s'engager à corriger
    // deux fois chaque bizarrerie du format.
    if (harness(kind).envelope === "claude") {
      const type = parsed.type
      if (type === "assistant") {
        // `/compact` : la CLI vient de réduire le contexte. Prévenir la fenêtre
        // pour qu'elle nettoie le fil comme le ferait le TUI du harnais.
        const compacte = compactIn(parsed)
        if (compacte) {
          target.send("agent:compacted", { id, conversationId: turn?.conversationId, summary: compacte.summary })
          return
        }
        const message = parsed.message as { content?: unknown[] } | undefined
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; text?: string; name?: string; id?: string; input?: unknown }
          if (b.type === "text" && b.text) send(b.text)
          if (b.type === "tool_use" && b.name) started(b.id ?? b.name, b.name, b.input)
        }
        return
      }

      // The results come back as a `user` message, which reads oddly until you
      // remember whose turn it is from the model's point of view: the tool
      // answered, and the answer is the user's half of the exchange.
      if (type === "user") {
        // Une question renvoyée par `--replay-user-messages` : la première est
        // celle du tour ; les suivantes ont été glissées en plein tour et
        // viennent d'être prises. La fenêtre les place là, dans le fil.
        if (parsed.isReplay === true) {
          // La réponse qui suit ouvre un nouveau message : pas de séparateur
          // de paragraphe devant son premier mot.
          if (rejeu) {
            if (++rejeu.replays > 1) {
              if (turn) turn.sentText = false
              target.send("agent:steered", { id, text: replayText(parsed) })
            }
          } else if (turn?.live) {
            turn.live.replays++
            if (turn.live.replays > 1) {
              turn.live.pending = Math.max(0, turn.live.pending - 1)
              turn.sentText = false
              target.send("agent:steered", { id, text: replayText(parsed) })
            }
          }
          return
        }
        const message = parsed.message as { content?: unknown[] } | undefined
        for (const block of message?.content ?? []) {
          const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }
          if (b.type === "tool_result" && b.tool_use_id) {
            finished(b.tool_use_id, b.content, Boolean(b.is_error))
          }
        }
        return
      }
      if (type === "result") {
        const spent = usageIn(parsed)
        if (spent) target.send("agent:usage", { id, ...spent })
        const result = parsed.result
        if (parsed.is_error && typeof result === "string") {
          this.sendError(target, { id, message: result })
        }
        // L'entrée de Claude reste ouverte tant qu'un message glissé n'a pas
        // été repris : arrivé trop tard pour ce tour-ci, il en ouvre un second
        // dans le même processus. Sinon, on ferme, et le processus sort.
        //
        // Mesuré : un message déjà écrit est traité même après la fermeture,
        // et `queued_turn_count` vaut 0 alors qu'un message attend — c'est
        // donc le compte des accusés qui décide, le compteur ne fait
        // qu'ajouter. Trente secondes au plus pour un accusé qui ne viendrait
        // pas.
        if (turn?.live && !rejeu) {
          const live = turn.live
          const attendus = typeof parsed.queued_turn_count === "number" ? parsed.queued_turn_count : 0
          if (live.closer) clearTimeout(live.closer)
          live.closer = null
          if (live.pending > 0 || attendus > 0) {
            if (attendus === 0) {
              live.closer = setTimeout(() => {
                if (!turn.child.stdin?.writableEnded) turn.child.stdin?.end()
              }, 30_000)
            }
            return
          }
          if (!turn.child.stdin?.writableEnded) turn.child.stdin?.end()
        }
        // Le tour est fini : c'est maintenant qu'on tient ce qu'il a demandé.
        if (turn && !rejeu) {
          this.honorWake(turn)
          turn.complete?.()
        }
        return
      }
      return
    }

    // MiMo Code — l'enveloppe d'opencode, relevée sur le binaire 0.1.15.
    //
    // Un outil arrive en un seul événement, `tool_use`, qui porte à la fois
    // l'appel et son résultat : le panneau reçoit les deux d'un coup. Une
    // erreur arrive en événement et le processus sort quand même avec 0 — le
    // flux, pas le code de sortie, dit qu'il n'y a pas de réponse.
    if (harness(kind).envelope === "opencode") {
      const part = parsed.part as
        | { text?: string; tool?: string; callID?: string; id?: string; state?: { status?: string; input?: unknown; output?: unknown; error?: unknown } }
        | undefined
      if (parsed.type === "text" && part?.text) {
        send(part.text)
        return
      }
      if (parsed.type === "tool_use" && part?.tool) {
        const callId = part.callID ?? part.id ?? part.tool
        started(callId, mimoToolName(part.tool), part.state?.input)
        const status = part.state?.status
        if (status === "completed" || status === "error") {
          finished(callId, status === "error" ? (part.state?.error ?? part.state?.output) : part.state?.output, status === "error")
        }
        return
      }
      if (parsed.type === "step_finish") {
        const spent = mimoUsageIn(parsed)
        if (spent && turn) {
          // Le panneau remplace la dépense d'un message à chaque envoi : on lui
          // donne le cumul des étapes, pas la dernière.
          turn.spent = addSpent(turn.spent ?? null, spent)
          target.send("agent:usage", { id, ...turn.spent })
        }
        return
      }
      if (parsed.type === "error") {
        const err = parsed.error as { name?: string; message?: string; data?: { message?: string } } | undefined
        const message = err?.data?.message || err?.message || err?.name || "MiMo Code reported an error."
        this.sendError(target, { id, message })
        return
      }
      return
    }

    // Codex
    //
    // Its stream names things differently and is younger; what is handled here
    // is what it was seen to emit. Anything unrecognised still reaches the
    // panel as text rather than being dropped, which is the rule this whole
    // function follows.
    const codexItem = parsed.item as
      | { type?: string; text?: string; id?: string; name?: string; arguments?: unknown; output?: unknown; command?: string }
      | undefined
    // Le reçu du tour, côté codex. Avant le reste : `turn.completed` ne porte
    // rien d'autre, et le panneau pose la dépense sur le message auquel elle
    // appartient.
    if (parsed.type === "turn.completed") {
      const spent = codexUsageIn(parsed)
      if (spent) target.send("agent:usage", { id, ...spent })
      return
    }
    // Le serveur d'application (main/codexserver.ts) : un message glissé vient
    // d'être pris, ou le tour a échoué.
    if (parsed.type === "zyvro.steered") {
      if (turn) turn.sentText = false
      target.send("agent:steered", { id, text: typeof parsed.text === "string" ? parsed.text : "" })
      return
    }
    if (parsed.type === "zyvro.failed") {
      this.sendError(target, { id, message: typeof parsed.message === "string" ? parsed.message : "Codex reported an error." })
      return
    }
    if (parsed.type === "item.started" && codexItem?.type === "command_execution") {
      started(codexItem.id ?? "codex", "Bash", { command: codexItem.command })
      return
    }
    if (parsed.type === "item.completed" && codexItem?.type === "command_execution") {
      finished(codexItem.id ?? "codex", codexItem.output, false)
      return
    }

    const item = parsed.item as { type?: string; text?: string } | undefined
    if (parsed.type === "item.completed" && item?.type === "agent_message" && item.text) {
      send(item.text)
      return
    }
    const msg = parsed.msg as { type?: string; message?: string } | undefined
    if (msg?.type === "agent_message" && msg.message) {
      send(msg.message)
      return
    }
    if (typeof parsed.last_agent_message === "string") send(parsed.last_agent_message)
  }

  /**
   * steer glisse un message dans un tour en cours. Faux quand ce tour ne le
   * permet pas ou plus : la fenêtre le garde alors pour le tour suivant.
   */
  async steer(id: string, text: string): Promise<boolean> {
    const turn = this.turns.get(id)
    if (!turn?.steer || text.trim() === "") return false
    try {
      return await turn.steer(text)
    } catch {
      return false
    }
  }

  cancel(id: string): void {
    const turn = this.turns.get(id)
    if (!turn) return
    turn.cancel?.()
  }

  // sendError : l'échec d'un tour, à la fenêtre et au journal du bouton bug.
  private sendError(target: WebContents, payload: { id: string; message: string }): void {
    const turn = this.turns.get(payload.id)
    recordIncident(`agent:${turn?.kind ?? "turn"}`, payload.message)
    target.send("agent:error", payload)
  }

  /**
   * Ce que ce processus tient de chaque tour, pour un rapport de bug.
   *
   * C'est la moitié qui manque quand l'écran reste sur « Writing… » : le
   * panneau croit un tour en cours, et seul ce côté sait si le processus de la
   * CLI vit encore, s'il a fini, ce qu'il a imprimé en dernier.
   */
  debugSnapshot(): Record<string, unknown> {
    const now = Date.now()
    return {
      turns: [...this.turns.values()].map((turn) => ({
        id: turn.id,
        conversationId: turn.conversationId,
        kind: turn.kind,
        projectDir: turn.projectDir,
        startedAt: turn.startedAt,
        ageSeconds: Math.round((now - turn.startedAt) / 1000),
        prompt: turn.prompt.slice(0, 2000),
        bytes: turn.bytes,
        sentText: turn.sentText,
        steerable: Boolean(turn.steer),
        live: turn.live ? { pending: turn.live.pending, replays: turn.live.replays, closing: turn.live.closer !== null } : null,
        wake: turn.wake,
        process: {
          pid: turn.child.pid ?? null,
          exitCode: turn.child.exitCode,
          signalCode: turn.child.signalCode,
          killed: turn.child.killed,
          stdinEnded: turn.child.stdin?.writableEnded ?? null,
        },
        lineCount: turn.lines.length,
        // Les dernières lignes brutes de la CLI : c'est là que se lit un tour
        // qui s'est arrêté sans le dire.
        lines: turn.lines.slice(-40).map((line) => line.slice(0, 4000)),
      })),
      scheduled: [...this.repeats.keys()],
    }
  }

  // cancelAll : la fenêtre s'en va, tout s'arrête avec elle.
  //
  // Les tours en cours ET les réveils armés. Les réveils manquaient, et ce
  // n'était pas seulement une fuite : le minuteur partait quand même à
  // l'heure dite, trouvait une fenêtre détruite et renonçait en silence. Ça
  // marchait par accident — le jour où quelqu'un rouvre une fenêtre pendant
  // qu'un ancien minuteur court encore, l'accident change de sens. La limite
  // qu'on annonce (« une boucle tient tant que la fenêtre tient ») doit être
  // tenue par du code qui la dit, pas par un `isDestroyed()` en chemin.
  //
  // Et tant que le minuteur court, sa fermeture retient cet objet et tout ce
  // qu'il tient : une conversation fermée il y a vingt minutes restait en
  // mémoire jusqu'à son réveil.
  cancelAll(): void {
    for (const id of [...this.turns.keys()]) this.cancel(id)
    for (const id of [...this.waking.keys()]) this.clearTimer(id)
    this.repeats.clear()
    this.gateway?.close()
    this.gateway = null
  }
}
