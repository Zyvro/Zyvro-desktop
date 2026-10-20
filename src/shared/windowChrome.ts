// La géométrie de la barre de titre, à un seul endroit.
//
// Sur macOS la barre de titre native est cachée (`titleBarStyle: "hidden"`) et les trois
// boutons — fermer, réduire, agrandir — flottent au-dessus de NOTRE barre. Trois
// nombres doivent donc s'accorder, et ils vivaient dans trois fichiers : la hauteur de la
// barre (une classe CSS), la position des boutons (le processus principal) et la place qu'on
// leur garde à gauche des onglets de projet (une autre classe CSS). Qu'un seul bouge et les
// boutons se retrouvent trop hauts, ou sous le premier onglet.
//
// Importé par les deux côtés, il n'importe rien. `scripts/check-window.mjs` vérifie que la
// barre du rendu s'y tient.

/** La hauteur de la barre de titre, en pixels (la classe `h-11`). */
export const TITLEBAR_HEIGHT = 44
/** Le diamètre d'un bouton de macOS. */
export const TRAFFIC_LIGHT_SIZE = 12
/** Ce que les trois boutons occupent : 3 × 12 px et 2 intervalles de 8 px. */
export const TRAFFIC_LIGHTS_WIDTH = 52
/** Où se place leur coin haut gauche : centrés dans la hauteur de la barre. */
export const TRAFFIC_LIGHTS = { x: 16, y: Math.round((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2) } as const
/** La place gardée à gauche du premier onglet : les boutons, et de l'air après. */
export const TRAFFIC_LIGHTS_INSET = TRAFFIC_LIGHTS.x + TRAFFIC_LIGHTS_WIDTH + 18

/** La plus petite fenêtre qui garde la barre lisible : les boutons, un onglet, les commandes. */
export const MIN_WINDOW = { width: 900, height: 600 } as const
