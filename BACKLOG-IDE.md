# Ce qui manque pour être à la hauteur de VS Code et de Cursor

La liste de travail de l'amélioration continue : une entrée à la fois, la plus
utile d'abord, une version taguée à chaque entrée livrée. Tenue à jour à chaque
itération — ce qui est fait descend dans « Livré », avec sa version.

L'ordre est celui de l'impact pour quelqu'un qui passe ses journées dedans,
rapporté à l'effort. Les bugs qui perdent du travail passent devant tout.

## À faire

1. **Palette de commandes (Cmd+Shift+P).** Un registre de commandes, dont le
   menu et la palette lisent la même liste.
2. **Barre d'état de l'éditeur.** Ligne/colonne, langage, fin de ligne,
   indentation.
3. **Menu contextuel des onglets.** Close Others, Close to the Right, Close
   All, Copy Path, Reveal in Explorer.
4. **Sauvegarde automatique** (après un délai, ou au changement d'onglet),
   désactivée par défaut.
5. **Réglages.** Taille de police, tabulation, retour à la ligne, minimap —
   aujourd'hui en dur dans `CodeEditor.tsx`.
6. **État git dans l'arbre.** Couleur et lettre M/U/A par fichier.
7. **Navigation au clavier dans l'arbre.** Flèches, Entrée, F2, Suppr.
8. **Révéler le fichier actif, tout replier.** Deux boutons dans l'en-tête de
   l'arbre.
9. **Onglet d'aperçu en italique, et épinglage** par double-clic.
10. **Réordonner les onglets en les glissant.**
11. **Aperçu Markdown**, avec le rendu déjà utilisé par le chat.
12. **Sélection multiple dans l'arbre** (Cmd/Maj-clic), que le glisser-déposer
    sait déjà transporter.
13. **Panneau Problems et plan du fichier**, depuis les marqueurs de Monaco.
14. **Terminal : effacer (Cmd+K) et scinder.**
15. **Éditeurs côte à côte et fil d'Ariane.**
16. **Un graphe modifié demande aussi avant de fermer**, comme un fichier.

Petits correctifs repérés en passant :

- fichiers récents à côté des projets récents ;
- icône par type de fichier plutôt qu'une couleur sur une icône unique ;
- `movePath` pourrait aussi faire suivre la pile des onglets fermés.

## Livré

- **0.1.0-alpha.8 — glisser-déposer.** Un fichier ou un dossier lâché depuis le
  Finder ou l'Explorateur Windows sur l'arbre y est copié (jamais écrasé,
  l'original reste en place) ; une ligne de l'arbre lâchée sur un dossier y est
  déplacée, ou copiée avec Alt. Un dossier replié s'ouvre au survol. Un dossier
  lâché sur la fenêtre s'ouvre comme projet ; un fichier du projet lâché sur
  l'éditeur s'ouvre dans un onglet. Les onglets suivent un fichier déplacé ou
  renommé, brouillon compris.
- **0.1.0-alpha.8 — ne plus perdre de travail.** ⌘S n'enregistre que l'onglet
  actif (il réécrivait tous les fichiers ouverts) ; Save All sur ⌘⌥S. Fermer un
  onglet modifié, la fenêtre ou l'application demande Save / Don't Save /
  Cancel, et un enregistrement raté ne ferme rien. ⌘W ferme l'onglet et non
  plus la fenêtre ; ⌘⇧T rouvre le dernier fermé ; clic du milieu pour fermer.
  L'accord ⌘K ⌘F, illisible pour Electron, est retiré.
- **0.1.0-alpha.8 — le .exe revient.** Le faux moteur d'un test ne se lançait
  pas sous Windows, et `.gitattributes` impose LF pour que les vérifications
  qui lisent les sources voient la même chose partout.
- **0.1.0-alpha.8 — Go to File (⌘P).** Recherche floue sur les chemins du
  projet (`shared/fuzzy`), récents d'abord, `chemin:ligne:colonne` accepté.
