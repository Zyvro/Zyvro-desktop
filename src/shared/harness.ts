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

export type AgentKind = "claude" | "codex" | "qwen"

// Comment un harnais raconte son tour.
//
// Deux formes, pas trois. Claude Code imprime un événement JSON par ligne, et
// Qwen Code imprime EXACTEMENT les mêmes — `{"type":"system","subtype":"init"}`,
// `{"type":"assistant","message":{…}}`, `{"type":"result","subtype":"success"}`,
// avec le même `session_id` et le même bloc `usage`. Relevé sur les binaires
// installés, pas supposé : ce sont les mêmes octets aux noms près.
//
// Codex a la sienne, faite d'`item.completed` et de `thread.started`.
export type Envelope = "claude" | "codex"

export type Harness = {
  kind: AgentKind
  /** Ce qu'on lance. Sur Windows le fichier porte une extension ; cli.ts s'en occupe. */
  bin: string
  /** Comment l'installer, pour que « pas trouvé » soit une phrase actionnable. */
  install: string
  /** La forme de sa sortie, donc quel analyseur la lit. */
  envelope: Envelope
  /**
   * Peut-on le viser ailleurs que sur son propre abonnement ?
   *
   * claude et codex parlent au dos de leur compte et n'en changent pas — on
   * peut bien leur donner une autre adresse, mais elle doit parler leur
   * protocole, et c'est une traduction à écrire. Qwen Code prend un
   * `--auth-type` et une adresse : les serveurs que ce projet connaît déjà
   * deviennent des dos d'agent sans qu'on traduise quoi que ce soit.
   *
   * C'est toute la différence entre « trois harnais » et « trois harnais fois
   * tous nos fournisseurs ».
   */
  aimable: boolean
}

export const HARNESSES: Record<AgentKind, Harness> = {
  claude: {
    kind: "claude",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    envelope: "claude",
    aimable: false,
  },
  codex: {
    kind: "codex",
    bin: "codex",
    install: "npm install -g @openai/codex",
    envelope: "codex",
    aimable: false,
  },
  qwen: {
    kind: "qwen",
    bin: "qwen",
    install: "npm install -g @qwen-code/qwen-code",
    envelope: "claude",
    aimable: true,
  },
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
