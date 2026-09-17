// Ce que l'agent a le droit de faire.
//
// Ce module est partagé par les trois côtés — le processus principal, le pont,
// le rendu — et c'est pourquoi il n'importe rien. Le pont importe `electron` ;
// une constante prise chez lui ferait entrer electron dans le paquet du rendu,
// qui s'écroule alors sur `__dirname is not defined`. C'est arrivé.

// La liste, une seule, et le type qui en découle. Elle est lue par le panneau
// qui la propose et par le processus principal qui la valide : une seconde
// liste écrite à la main a déjà coûté un « Ask » silencieusement remplacé par
// « Workspace ».
export const PERMISSIONS = ["read", "ask", "project", "yolo"] as const

export type Permission = (typeof PERMISSIONS)[number]

// Par défaut : tout le projet, sans rien demander. C'est ce qu'on attend d'un
// agent qui travaille dans le dossier qu'on vient de lui ouvrir — le shell
// intégré, à côté, n'a jamais rien demandé non plus. « Ask » existe pour ceux
// qui veulent voir venir, et « Read only » pour ne rien risquer du tout.
export const DEFAULT_PERMISSION: Permission = "project"

// L'outil par lequel la CLI demande la permission.
//
// C'est le serveur MCP de l'application qui le sert : la question remonte donc
// dans le panneau, avec deux boutons, au lieu de mourir dans un tour en mode
// impression qui ne peut répondre à personne.
export const PERMISSION_TOOL = "mcp__zyvro-app__zyvro_permission"
