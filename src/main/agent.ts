import { type ChildProcess } from "node:child_process"
import { installed as cliInstalled, launchPiped } from "./cli"
import { describeTool, outputIn, planIn } from "./tooltalk"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { WebContents } from "electron"
import { codexMcpArgs, mcpAvailable, mcpServers, mcpTokenEnv, writeMcpConfig } from "./mcp"
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
export function claudeMcpConfig(ctx: AgentContext): { path: string; dispose: () => void } {
  return writeMcpConfig(ctx)
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
  aim: Aim | null = null
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
      // Rien ne demande. Les outils de fichiers de claude restent confinés à
      // son dossier de travail — celui du projet — donc « tout » veut dire
      // « tout ce qu'il peut atteindre », et c'est le projet.
      return ["--permission-mode", "bypassPermissions"]
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
      // Tout ce qu'il peut atteindre, c'est-à-dire le projet : ses outils de
      // fichiers vivent dans son dossier de travail.
      return ["--approval-mode", "yolo"]
    default:
      // `default` demande. Sans personne pour répondre, demander est une
      // attente infinie : mieux vaut un mode qui ne peut rien casser.
      return canAsk ? ["--approval-mode", "default"] : ["--approval-mode", "plan"]
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
    const resume = this.sessionFor(kind, conversationId)
    const bin = this.available(kind)
    const env: NodeJS.ProcessEnv = { ...process.env }
    let disposeConfig: (() => void) | null = null

    const args: string[] = argsFor(kind, ctx, resume ?? null, model, images, aim)
    // La clef du point d'accès arrive ici et pas dans `args` : la table des
    // processus est lisible par tout ce qui tourne sur cette machine.
    if (aim) Object.assign(env, aimEnv(aim))

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
        const config = claudeMcpConfig(ctx)
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
    const child = launchPiped(bin, args, { cwd: ctx.projectDir, env })
    this.turns.set(id, { id, conversationId, kind, child, sentText: false })

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
    const finished = (callId: string, content: unknown, isError: boolean) =>
      target.send("agent:tool-result", { id, callId, output: outputIn(content), isError })

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

  cancelAll(): void {
    for (const id of [...this.turns.keys()]) this.cancel(id)
  }
}
