// L'allure d'un bouton de la barre verticale de l'agent : une icône seule,
// carrée, la même pour tous. Le nom et l'état sont dans l'infobulle — la barre
// est étroite exprès, pour laisser la largeur du panneau à la conversation.
export const RAIL_BUTTON =
  "relative flex h-6 w-6 shrink-0 items-center justify-center rounded outline-none hover:bg-white/[0.08] focus-visible:ring-1 focus-visible:ring-white/30 disabled:opacity-40 data-[state=open]:bg-white/[0.08]"

/** Les menus de la barre s'ouvrent vers la gauche, vers la conversation. */
export const RAIL_MENU = { side: "left", align: "end", sideOffset: 6, collisionPadding: 8 } as const
