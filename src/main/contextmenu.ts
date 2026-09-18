// Ce que le clic droit propose dans la fenêtre de l'application.
//
// Il n'y en avait pas : seule la vue invitée du navigateur en avait un. Avec le
// menu Édition et son raccourci, Cmd+C marchait — mais seulement pour qui pense
// à le chercher, et seulement une fois qu'il y a quelque chose de sélectionné.
// Or rien ne se sélectionnait : voir la règle de `styles.css`. Les deux moitiés
// du même défaut, « impossible de copier les textes d'erreur et les prompts ».
//
// Dans son propre fichier plutôt que dans `index.ts` pour être vérifiable sans
// écran : ce qui casse ici, c'est un élément au mauvais moment — « Coller » là
// où rien ne s'écrit, « Copier » sans rien de sélectionné — et c'est la forme
// des paramètres qui le décide, pas l'affichage. `index.ts`, lui, touche à
// `app.isPackaged` dès qu'on le charge, ce qu'un garde ne peut pas faire.

import type { MenuItemConstructorOptions } from "electron"

// appContextTemplate : le nécessaire, et rien de plus.
//
// Les rôles plutôt que des actions écrites à la main — ils portent les
// raccourcis du système et le grisé quand il n'y a rien à coller.
export function appContextTemplate(selection: string, editable: boolean): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (selection.trim() !== "") items.push({ label: "Copy", role: "copy" })
  if (editable) {
    items.push({ label: "Cut", role: "cut" }, { label: "Paste", role: "paste" })
  }
  // « Tout sélectionner » n'a de sens que là où il y a quelque chose à prendre :
  // dans un champ, ou sur une sélection qu'on veut élargir. Un menu à une seule
  // ligne grisée n'apprend rien, donc on n'ouvre rien.
  if (items.length > 0) items.push({ type: "separator" }, { label: "Select all", role: "selectAll" })
  return items
}
