# Ce qui manque pour être à la hauteur de VS Code et de Cursor

La liste de travail de l'amélioration continue : une entrée à la fois, la plus
utile d'abord, une version taguée à chaque entrée livrée. Tenue à jour à chaque
itération — ce qui est fait descend dans « Livré », avec sa version.

L'ordre est celui de l'impact pour quelqu'un qui passe ses journées dedans,
rapporté à l'effort. Les bugs qui perdent du travail passent devant tout.

## À faire

1. **Cmd+S n'enregistre que l'onglet visible.** Le menu Save déclenche la
   commande `save` sur *tous* les éditeurs montés (`CodeEditor.tsx`), qui
   restent montés onglet caché : Cmd+S réécrit chaque fichier ouvert. Find
   vérifie déjà la visibilité, Save non.
2. **Fermer un onglet modifié demande.** Aujourd'hui la croix jette les
   modifications (« Close without saving »). Save / Don't Save / Cancel.
3. **Quitter avec des fichiers non enregistrés demande.** `win.on("close")`
   côté principal, en demandant au rendu s'il reste des brouillons.
4. **Quick Open (Cmd+P).** Recherche floue sur les chemins du projet.
5. **Palette de commandes (Cmd+Shift+P).** Un registre de commandes, dont le
   menu et la palette lisent la même liste.
6. **Barre d'état de l'éditeur.** Ligne/colonne, langage, fin de ligne,
   indentation.
7. **Save All, et sauvegarde automatique** (après un délai, ou au changement
   d'onglet).
8. **Menu contextuel des onglets.** Close Others, Close to the Right, Close
   All, Copy Path, Reveal in Explorer ; clic du milieu pour fermer.
9. **Rouvrir l'onglet fermé (Cmd+Shift+T).**
10. **Réglages.** Taille de police, tabulation, retour à la ligne, minimap —
    aujourd'hui en dur dans `CodeEditor.tsx`.
11. **État git dans l'arbre.** Couleur et lettre M/U/A par fichier.
12. **Navigation au clavier dans l'arbre.** Flèches, Entrée, F2, Suppr.
13. **Révéler le fichier actif, tout replier.** Deux boutons dans l'en-tête de
    l'arbre.
14. **Onglet d'aperçu en italique, et épinglage** par double-clic.
15. **Réordonner les onglets en les glissant.**
16. **Aperçu Markdown**, avec le rendu déjà utilisé par le chat.
17. **Sélection multiple dans l'arbre** (Cmd/Maj-clic), que le glisser-déposer
    sait déjà transporter.
18. **Panneau Problems et plan du fichier**, depuis les marqueurs de Monaco.
19. **Terminal : effacer (Cmd+K) et scinder.**
20. **Éditeurs côte à côte et fil d'Ariane.**

Petits correctifs repérés en passant :

- l'accélérateur « Close Folder » est un accord (`Cmd+K Cmd+F`), qu'Electron ne
  sait pas lire ;
- fichiers récents à côté des projets récents ;
- icône par type de fichier plutôt qu'une couleur sur une icône unique.

## Livré

- **0.1.0-alpha.8 — glisser-déposer.** Un fichier ou un dossier lâché depuis le
  Finder ou l'Explorateur Windows sur l'arbre y est copié (jamais écrasé,
  l'original reste en place) ; une ligne de l'arbre lâchée sur un dossier y est
  déplacée, ou copiée avec Alt. Un dossier replié s'ouvre au survol. Un dossier
  lâché sur la fenêtre s'ouvre comme projet ; un fichier du projet lâché sur
  l'éditeur s'ouvre dans un onglet. Les onglets suivent un fichier déplacé ou
  renommé, brouillon compris.
