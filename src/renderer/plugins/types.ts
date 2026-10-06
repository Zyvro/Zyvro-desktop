import type { AgentKind } from "../../shared/harness"
import type { Permission } from "../../shared/permission"
import type { PluginId } from "../../shared/plugins"
import type { TaskStatus } from "../../shared/tasks"

// Ce qu'un plugin d'agent reçoit, et ce qu'il peut fournir.
//
// Le panneau du chat est l'hôte : il sait ce qu'est une conversation, un tour,
// un brouillon. Un plugin ne touche à rien de tout ça directement — il lit
// l'instantané qu'on lui donne et appelle les actions qu'on lui prête. C'est ce
// qui permet d'en éteindre un sans que le panneau ne casse : il n'y a plus,
// dans AgentPanel, une ligne qui nomme la mémoire ou la file de tâches.

/** La conversation affichée, vue de la barre de droite. */
export type AgentRailContext = {
  kind: AgentKind
  /** Le panneau ne peut rien envoyer (harnais absent, pas connecté…). */
  disabled: boolean
  permission: Permission
  /** Le dossier du projet au premier plan, ou null. */
  project: string | null
  thread: {
    id: string
    model: string | null
    ranWith: string | null
    /** Jetons dans le contexte au dernier tour, ou null. */
    context: number | null
    busy: boolean
    queued: number
    /** Un premier message est parti : la session existe côté CLI. */
    started: boolean
    advancedSkills: boolean
  }
  draft: string
  /** L'auto-synthèse réécrit la boîte en ce moment. */
  rewriting: boolean
  /** Les commandes slash que ce harnais connaît. */
  commands: string[]
  actions: {
    /** Une demande qui ne vient pas de la boîte, dans une conversation à elle, affichée. */
    runInThread: (title: string, prompt: string) => void
    setAdvancedSkills: (on: boolean) => void
    /** Envoyer `/compact` tel quel à cette conversation. */
    compact: () => void
    /** Réécrire la boîte tout de suite, sans l'envoyer. */
    rewriteNow: () => void
    /** L'état du panneau, pour un rapport de bug. */
    snapshot: () => unknown
  }
}

export type AgentPlugin = {
  id: PluginId
  /** Son bouton dans la barre de droite du chat. */
  Rail?: (props: { ctx: AgentRailContext }) => JSX.Element | null
  /** Ses réglages propres, sous son interrupteur dans Settings › Plugins. */
  Settings?: () => JSX.Element | null
  /** Un tour vient de finir, dans cette conversation. */
  turnEnded?: (threadId: string, status: TaskStatus) => void
}
