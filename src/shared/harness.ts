// Les harnais : les agents en ligne de commande que ce panneau sait piloter.
//
// Un harnais n'est pas un modèle. C'est le programme qui tient la boucle —
// lire un fichier, lancer une commande, redemander au modèle — et il a son
// propre protocole, ses propres drapeaux et sa propre façon de raconter ce
// qu'il fait. Le modèle, lui, est ce à quoi le harnais parle.
//
// Cette table est la seule liste. Avant elle il y en avait deux, `AgentKind`
// déclaré dans le processus principal et redéclaré dans le préchargement, plus
// une troisième écrite à la main dans le sélecteur du panneau. Trois listes qui
// disaient la même chose, et un troisième harnais à ajouter : c'est le moment
// exact où elles se mettent à diverger.

export type AgentKind = "claude" | "codex" | "qwen" | "mimo"

// Comment un harnais raconte son tour.
//
// Deux formes, pas trois. Claude Code imprime un événement JSON par ligne, et
// Qwen Code imprime EXACTEMENT les mêmes — `{"type":"system","subtype":"init"}`,
// `{"type":"assistant","message":{…}}`, `{"type":"result","subtype":"success"}`,
// avec le même `session_id` et le même bloc `usage`. Relevé sur les binaires
// installés, pas supposé : ce sont les mêmes octets aux noms près.
//
// Codex a la sienne, faite d'`item.completed` et de `thread.started`.
// MiMo Code imprime celle d'opencode, dont il est un fork : `text`, `tool_use`
// (l'appel et son résultat dans un seul événement), `step_finish` et son
// compte de jetons, `error`, et `sessionID` partout.
export type Envelope = "claude" | "codex" | "opencode"

export type Harness = {
  kind: AgentKind
  /** Ce qu'on lance. Sur Windows le fichier porte une extension ; cli.ts s'en occupe. */
  bin: string
  /** Comment l'installer, pour que « pas trouvé » soit une phrase actionnable. */
  install: string
  /**
   * Le paquet npm qui l'apporte. Le bouton « Install » le lance tel quel :
   * `npm install -g <paquet>`, et rien que le principal ne compose.
   */
  npmPackage?: string
  /**
   * Ou, pour un harnais qui ne passe pas par npm, l'installateur que
   * l'application porte elle-même — MiMo Code, que Xiaomi publie en binaires
   * (voir main/mimoinstall.ts). Il marche partout, Windows compris, sans
   * commande à taper.
   */
  installer?: "mimo"
  /** La forme de sa sortie, donc quel analyseur la lit. */
  envelope: Envelope
  /**
   * Peut-on le viser ailleurs que sur son propre abonnement ?
   *
   * Qwen Code prend un `--auth-type` et une adresse : les serveurs que ce
   * projet connaît déjà deviennent des dos d'agent sans qu'on traduise quoi que
   * ce soit.
   *
   * codex, lui, ne poste que sur l'API Responses d'OpenAI — son réglage
   * `wire_api = "chat"` a été retiré. Il est visable depuis le 18/09 parce que
   * la traduction a été écrite : `shared/responses.ts` et la passerelle de
   * `main/responses.ts` se mettent entre lui et un serveur Chat Completions.
   *
   * claude ne poste que sur l'API Messages d'Anthropic, et il l'est depuis que
   * `shared/messages.ts` existe — pour la même raison et par le même chemin.
   * « Personne ne l'a demandé » a tenu jusqu'au jour où quelqu'un a ouvert le
   * menu des modèles sur claude et n'y a pas trouvé ses serveurs.
   *
   * C'est toute la différence entre « trois harnais » et « trois harnais fois
   * tous nos fournisseurs ».
   */
  aimable: boolean
  /**
   * Passe-t-il par la passerelle pour atteindre un serveur Chat Completions ?
   *
   * Qwen Code parle Chat nativement : on lui donne l'adresse du fournisseur et
   * il appelle. Les deux autres parlent chacun leur protocole, et la passerelle
   * traduit — c'est elle qui porte la clef du fournisseur, donc elle n'est
   * allumée que pour qui en a besoin.
   *
   * Écrit ici plutôt que déduit d'une liste de noms dans `openGateway` : un
   * quatrième harnais s'ajoute dans cette table, et rien d'autre ne doit être
   * à retrouver ailleurs.
   */
  gateway: boolean
}

/**
 * Les modèles proposés pour un harnais, et ce qui a empêché d'en proposer plus.
 *
 * `trouble` existe parce qu'une liste vide ne dit pas pourquoi elle est vide.
 * « Aucun serveur ne répond » et « ce serveur a répondu autre chose qu'une
 * liste » demandent deux gestes différents, et le menu ne peut pas choisir la
 * bonne phrase s'il ne reçoit que le vide.
 */
export type ModelChoices = {
  models: string[]
  trouble: { provider: string; said: string }[]
}

export const HARNESSES: Record<AgentKind, Harness> = {
  claude: {
    kind: "claude",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    npmPackage: "@anthropic-ai/claude-code",
    envelope: "claude",
    aimable: true,
    gateway: true,
  },
  codex: {
    kind: "codex",
    bin: "codex",
    install: "npm install -g @openai/codex",
    npmPackage: "@openai/codex",
    envelope: "codex",
    aimable: true,
    gateway: true,
  },
  qwen: {
    kind: "qwen",
    bin: "qwen",
    install: "npm install -g @qwen-code/qwen-code",
    npmPackage: "@qwen-code/qwen-code",
    envelope: "claude",
    aimable: true,
    gateway: false,
  },
  // MiMo Code, le CLI de Xiaomi, déjà connecté au compte MiMo de la personne.
  // Ce n'est pas codex sous un autre nom : c'est son propre harnais, avec son
  // propre flux (celui d'opencode, dont il est un fork) — relevé sur le binaire
  // 0.1.15 plutôt que supposé.
  mimo: {
    kind: "mimo",
    bin: "mimo",
    // Une phrase et pas une commande : sous Windows il n'y a pas de bash à qui
    // donner `curl … | bash`, et le bouton Install fait le travail partout.
    install: "the Install button in the agent panel, which downloads it from Xiaomi",
    installer: "mimo",
    envelope: "opencode",
    aimable: false,
    gateway: false,
  },
}

// speaksCodex : ce harnais est-il codex ? Ce qui dépend du binaire — la
// sous-commande `resume`, la question sur stdin, le bac à sable — se demande
// ici plutôt qu'à `kind === "codex"`, pour qu'un harnais bâti sur codex en
// hérite sans qu'on ait à le retrouver partout.
export function speaksCodex(kind: AgentKind | string): boolean {
  return harness(kind).bin === "codex"
}

// L'ordre du sélecteur, et le seul endroit qui le décide.
export const AGENT_KINDS = Object.keys(HARNESSES) as AgentKind[]

// harness rend la ligne d'un harnais, en se rabattant sur claude pour une
// valeur venue d'une vieille conversation enregistrée avant que ce harnais
// existe. Une conversation qu'on rouvre ne doit pas planter parce qu'elle porte
// un nom qu'on ne donne plus.
export function harness(kind: AgentKind | string): Harness {
  return HARNESSES[kind as AgentKind] ?? HARNESSES.claude
}

// isAgentKind dit si une valeur lue sur le disque ou reçue du rendu nomme un
// harnais. Tout ce qui traverse une frontière est du texte jusqu'à preuve du
// contraire.
export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && value in HARNESSES
}

// ---- viser un harnais ----------------------------------------------------

// Aim est l'endroit où le harnais va chercher son modèle : une adresse et, si
// le serveur en demande une, une clef.
//
// La clef ne voyage jamais dans les arguments — voir `aimEnv`. Elle ne descend
// pas non plus dans le rendu : le processus principal la lit et la passe au
// sous-processus, la fenêtre ne la voit pas.
export type Aim = { provider: string; url: string; key: string; model: string }

// Un modèle visé s'écrit « fournisseur/modèle » — « lmstudio/qwen3-coder-next ».
//
// Une seule chaîne porte les deux parce qu'un choix les décide tous les deux :
// choisir un modèle dans la liste d'un serveur, c'est choisir ce serveur. Les
// tenir dans deux réglages laisserait exister l'état « le modèle de LM Studio,
// demandé à Ollama », qui ne veut rien dire et qui répond 404.
export function splitAimed(model: string | null): { provider: string; model: string } | null {
  if (!model) return null
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return null
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
}

export function joinAimed(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * SHELL_YOLO : ce que reçoit un harnais ouvert dans un terminal.
 *
 * Ce shell sert à confier un projet entier à un agent, et une CLI qui s'arrête
 * à chaque commande pour demander l'autorisation défait l'intérêt de l'avoir
 * lancée. Ça ne touche que les deux boutons du terminal : les tours du panneau
 * gardent la permission qu'on leur a choisie.
 *
 * Les guillemets doubles de codex sont du TOML pour `-c`, pas du shell.
 */
export const SHELL_YOLO: Record<"claude" | "codex" | "mimo", readonly string[]> = {
  claude: ["--permission-mode=bypassPermissions", "--allow-dangerously-skip-permissions"],
  // MiMo Code : tout approuver, et ne pas s'arrêter sur la question « faites-
  // vous confiance à ce dossier ? » — le shell a été ouvert dans le projet.
  mimo: ["--dangerously-skip-permissions", "--trust"],
  codex: ["-c", 'model_reasoning_effort="high"', "--dangerously-bypass-approvals-and-sandbox"],
}

// Un argument tapé dans un shell : tel quel s'il n'a rien que le shell
// interprète, entre apostrophes sinon — `'model_reasoning_effort="high"'`.
function forShell(arg: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

// interactiveCommand : la ligne à taper dans un terminal pour ouvrir le harnais
// dans son interface à lui, sur la même conversation que le panneau.
//
// Le panneau pilote la CLI en mode « une question, une réponse » ; certaines
// choses se font mieux dans son interface plein écran — ses propres commandes,
// ses propres raccourcis, un long travail qu'on veut suivre. Les deux se
// reprennent de la même façon qu'au panneau : `--resume` pour claude et qwen,
// la sous-commande `resume` pour codex (`codex resume <id>`, identifiant
// positionnel). Sans session encore, le harnais nu — en YOLO dans les deux cas.
export function interactiveCommand(kind: AgentKind, sessionId: string | null): string {
  // Un identifiant de session est fait de lettres, chiffres et tirets ; tout
  // autre caractère est refusé plutôt que cité — il part dans un shell.
  const id = sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : null
  const bin = HARNESSES[kind].bin
  const yolo =
    kind === "claude" || kind === "mimo"
      ? SHELL_YOLO[kind].map(forShell)
      : speaksCodex(kind)
        ? SHELL_YOLO.codex.map(forShell)
        : []
  // `codex resume` prend ses options après la sous-commande, comme `--help`
  // les liste ; l'identifiant reste le dernier mot.
  const parts =
    speaksCodex(kind)
      ? id
        ? [bin, "resume", ...yolo, id]
        : [bin, ...yolo]
      : kind === "mimo"
        ? [bin, ...yolo, ...(id ? ["--session", id] : [])]
        : [bin, ...yolo, ...(id ? ["--resume", id] : [])]
  return parts.join(" ")
}
