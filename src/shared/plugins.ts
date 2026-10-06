// Les fonctions de l'agent, en plugins.
//
// Demandé : que chaque fonction ajoutée autour de l'agent — la file de tâches,
// la mémoire, les permissions, l'auto-synthèse… — soit un plugin, qu'on allume
// ou qu'on éteint, au lieu d'un morceau câblé en dur dans le panneau du chat.
//
// Ce module est le catalogue, et le seul : la liste des plugins, ce qu'ils
// font, ce qui se passe quand on les éteint, et la valeur par défaut. Il est lu
// par les trois côtés — le principal (la mémoire et les skills se décident là,
// au moment de lancer le tour), le pont, et le rendu (qui dessine la barre et
// la page de réglages à partir d'ici) — et n'importe donc rien. Le rendu a,
// dans `src/renderer/plugins/`, un module par entrée de cette liste ; le type
// `Record<PluginId, …>` y refuse d'en oublier un.
//
// Ce qui n'est PAS ici, et pourquoi :
//
//   · le harnais et le modèle : sans eux il n'y a pas d'agent du tout ;
//   · les questions de l'agent (AskUserQuestion) : elles passent par le même
//     outil MCP que les demandes de permission du niveau « Ask », et couper
//     l'un couperait l'autre en silence ;
//   · les bannières /goal et /loop : elles montrent ce que le harnais fait de
//     lui-même, et la seconde porte le seul bouton qui arrête un réveil.
//
// Pur : `scripts/check-plugins.mjs`.

/** Où un plugin vit : la barre de droite (en deux groupes), ou les réponses. */
export type PluginSection = "project" | "conversation" | "answers" | "app"

export const AGENT_PLUGINS = [
  {
    id: "tasks",
    name: "Task queue",
    section: "project",
    description: "Schedule prompts for this project and let them run one at a time when the agent is free.",
    whenOff: "The queue button is hidden and no task starts. Tasks stay saved in the project.",
  },
  {
    id: "memory",
    name: "Project memory",
    section: "project",
    description: "Give every turn the project's ZYVRO.md, and let the agent create or update it.",
    whenOff: "The memory button is hidden and ZYVRO.md is no longer sent to the agent. The file is kept.",
  },
  {
    id: "permissions",
    name: "Permission picker",
    section: "conversation",
    description: "Choose what the agent may do from the chat toolbar.",
    whenOff: "The toolbar picker is hidden. The last level chosen still applies; change it in Settings › Permissions.",
  },
  {
    id: "synthesis",
    name: "Auto-synthesize",
    section: "conversation",
    description: "Rewrite a prompt before sending it: translate it, clarify it, or turn it into a structured task.",
    whenOff: "Prompts are sent exactly as typed and the rewrite button is hidden.",
  },
  {
    id: "skills",
    name: "Advanced skills",
    section: "conversation",
    description: "Offer the agent the catalog of local skills so it can pick the relevant ones.",
    whenOff: "No skill catalog is sent. Skills configured directly in your CLI are not affected.",
  },
  {
    id: "compact",
    name: "Context gauge",
    section: "conversation",
    description: "Show how full the model's context is, and compact it in one click.",
    whenOff: "The gauge is hidden. Typing /compact still works.",
  },
  {
    id: "usage",
    name: "Token usage",
    section: "answers",
    description: "Show the tokens each answer spent, under the answer.",
    whenOff: "No usage line under answers.",
  },
  {
    id: "speech",
    name: "Read aloud",
    section: "answers",
    description: "A button on each answer that reads it aloud.",
    whenOff: "The button is hidden.",
  },
  {
    id: "bugReport",
    name: "Bug report",
    section: "app",
    description: "Report a problem from the chat toolbar, with the app's state attached.",
    whenOff: "The toolbar button is hidden.",
  },
] as const satisfies readonly {
  id: string
  name: string
  section: PluginSection
  description: string
  whenOff: string
}[]

export type PluginId = (typeof AGENT_PLUGINS)[number]["id"]
export type PluginStates = Record<PluginId, boolean>

export const PLUGIN_IDS: readonly PluginId[] = AGENT_PLUGINS.map((p) => p.id)

// Tout allumé : c'est ce que faisait l'application avant que ce soit des
// plugins, et une mise à jour ne doit rien retirer à personne.
export const DEFAULT_PLUGINS: PluginStates = Object.fromEntries(PLUGIN_IDS.map((id) => [id, true])) as PluginStates

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === "string" && (PLUGIN_IDS as readonly string[]).includes(value)
}

// sanitizePlugins relit ce qui vient du stockage.
//
// Un identifiant inconnu (un plugin retiré, une faute de frappe dans
// settings.json) est oublié ; une valeur qui n'est pas un booléen garde le
// défaut. `legacy` reprend les réglages d'avant les plugins : « Advanced
// skills » était un interrupteur à lui, `agent.advancedSkills`, et le choix
// fait là ne doit pas se perdre à la mise à jour.
export function sanitizePlugins(raw: unknown, legacy: Partial<Record<PluginId, unknown>> = {}): PluginStates {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return Object.fromEntries(
    PLUGIN_IDS.map((id) => {
      // Ses propres clés seulement : une valeur héritée n'a été écrite par personne.
      const own = Object.prototype.hasOwnProperty.call(r, id) ? r[id] : undefined
      const value = typeof own === "boolean" ? own : typeof legacy[id] === "boolean" ? legacy[id] : DEFAULT_PLUGINS[id]
      return [id, value]
    })
  ) as PluginStates
}

/** Le plugin est-il allumé ? Sans réglages (un vieux client, un test) : oui. */
export function pluginOn(settings: { plugins?: Partial<PluginStates> } | null | undefined, id: PluginId): boolean {
  const value = settings?.plugins?.[id]
  return typeof value === "boolean" ? value : DEFAULT_PLUGINS[id]
}
