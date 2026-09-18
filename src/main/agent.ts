import { type ChildProcess } from "node:child_process"
import { installed as cliInstalled, launchPiped } from "./cli"
import { describeTool, imagesIn, outputIn, planIn } from "./tooltalk"
import { keep as keepImage } from "./attachments"
import { commandsIn, remember as rememberCommands } from "./commands"
import { type Goal, goalIn, sameGoal } from "./goal"
import { nextRunIn, type Pending, type Wake, wakeIn } from "./schedule"
import { startGateway, type GatewayHandle } from "./responses"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { WebContents } from "electron"
import { codexMcpArgs, mcpAvailable, mcpServers, mcpTokenEnv, writeMcpConfig, type McpDialect } from "./mcp"
import { shotsEndpoint } from "./shots"
import { DEFAULT_PERMISSION, PERMISSION_TOOL, type Permission } from "../shared/permission"
import { AGENT_KINDS, type Aim, type AgentKind, harness } from "../shared/harness"

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
      "--verbose",
      // Ce que l'agent a le droit de faire, dit à claude.
      //
      // Un tour en mode impression ne peut poser aucune question : sans ça, la
      // CLI demande la permission d'écrire, personne ne peut répondre, et
      // l'agent rend « you haven't granted it yet » pour un fichier du dossier
      // qu'on vient de lui ouvrir.
      // La question ne peut remonter que si le serveur MCP de l'application
      // tourne : c'est lui qui sert l'outil de permission. Sans lui, mieux vaut
      // refuser tout de suite que laisser l'agent attendre une réponse qui
      // n'arrivera pas.
      ...claudePermission(ctx.permission ?? DEFAULT_PERMISSION, Boolean(shotsEndpoint())),
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
      return [
        "--disallowedTools",
        "Write,Edit,MultiEdit,NotebookEdit,Bash",
        "--permission-mode",
        "manual",
        "--permission-prompts",
        "none",
      ]
    case "yolo":
      return ["--dangerously-skip-permissions"]
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
      // `--permission-prompts none` va avec : en mode impression personne ne
      // peut répondre, et ce qui demanderait doit être refusé plutôt que
      // d'attendre une réponse qui n'arrivera pas.
      return ["--permission-mode", "acceptEdits", "--permission-prompts", "none"]
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

// codex ne sait pas demander en cours de tour : `codex exec` n'a pas de crochet
// d'approbation qu'on puisse brancher sur l'interface. Son bac à sable est donc
// la réponse — il décide d'avance de ce qui est possible, au lieu de demander.
export function codexPermission(permission: Permission): string[] {
  switch (permission) {
    case "read":
      return ["--sandbox", "read-only"]
    case "yolo":
      return ["--dangerously-bypass-approvals-and-sandbox"]
    default:
      // Le dossier du projet, et nulle part ailleurs.
      return ["--sandbox", "workspace-write"]
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
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

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
  return {
    input: fresh + cacheWrite + cacheRead,
    output,
    cacheRead,
    cacheWrite,
    costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
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
  const value = event.session_id ?? event.thread_id
  return typeof value === "string" && value ? value : null
}

type Turn = {
  id: string
  conversationId: string
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
  async openGateway(kind: AgentKind, aim: Aim, key: string): Promise<void> {
    if (kind !== "codex") return
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
      kind === "codex" && aim && this.gateway ? { baseUrl: this.gateway.baseUrl, keyVar: GATEWAY_KEY_VAR } : null
    const args: string[] = argsFor(kind, ctx, resume ?? null, model, images, aim, passerelle)
    // La clef du point d'accès arrive ici et pas dans `args` : la table des
    // processus est lisible par tout ce qui tourne sur cette machine.
    //
    // Et seulement pour qui les lit : `OPENAI_BASE_URL` est ce que Qwen Code
    // attend. codex, lui, passe par la passerelle et lit son jeton à elle —
    // lui poser en plus l'adresse d'un fournisseur serait un second chemin
    // vers le même serveur, c'est-à-dire celui des deux qui aura tort.
    if (aim && kind === "qwen") Object.assign(env, aimEnv(aim))
    if (passerelle && this.gateway) env[GATEWAY_KEY_VAR] = this.gateway.token

    if (mcpAvailable(ctx)) {
      if (kind === "claude") {
        const config = claudeMcpConfig(ctx)
        disposeConfig = config.dispose
        args.push(
          "--mcp-config",
          config.path,
          // Only this project's server. Without it the user's own MCP servers
          // would also load into the panel, which is a surprise nobody asked
          // for and a different set of tools on every machine.
          "--strict-mcp-config",
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
      } else {
        // Codex reads the token from the environment rather than from a flag,
        // which keeps it out of the process table.
        Object.assign(env, mcpTokenEnv(ctx))
        args.push(...codexMcpArgs(ctx))
      }
    }

    if (kind === "codex") args.push("-")

    const withImages = promptWith(kind, prompt, images)
    const text = kind === "codex" ? `${preamble(ctx)}\n\n---\n\n${withImages}` : withImages

    // launch rather than spawn: it resolves the real file, which on Windows
    // carries an extension and may be a .cmd that Node refuses to start
    // without a shell.
    // La commande d'installation vient de la table des harnais, qui la porte
    // déjà : l'écrire une seconde fois dans le message d'erreur serait la
    // deuxième liste qui a tort le jour où le paquet change de nom.
    const child = launchPiped(bin, args, { cwd: ctx.projectDir, env }, harness(kind).install)
    this.turns.set(id, { id, conversationId, kind, wake: null, child, sentText: false })

    child.stdin.write(text)
    child.stdin.end()

    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) this.emitEvent(target, id, kind, line)
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
      this.turns.delete(id)
      disposeConfig?.()
      disposeConfig = null
      const detail =
        err.code === "ENOENT"
          ? `"${bin}" is not on your PATH. Install it and sign in, then reopen this panel.`
          : err.message
      if (!target.isDestroyed()) target.send("agent:error", { id, message: detail })
    })

    child.on("exit", (code) => {
      this.turns.delete(id)
      disposeConfig?.()
      disposeConfig = null
      if (target.isDestroyed()) return
      if (buffer.trim()) this.emitEvent(target, id, kind, buffer.trim())
      if (code !== 0) {
        target.send("agent:error", { id, message: stderr.trim() || `${bin} exited with code ${code}` })
        return
      }
      target.send("agent:done", { id })
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

  private emitEvent(target: WebContents, id: string, kind: AgentKind, line: string): void {
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
          target.send("agent:error", { id, message: result })
        }
        // Le tour est fini : c'est maintenant qu'on tient ce qu'il a demandé.
        if (turn) this.honorWake(turn)
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

  cancel(id: string): void {
    const turn = this.turns.get(id)
    if (!turn) return
    this.turns.delete(id)
    turn.child.kill()
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
