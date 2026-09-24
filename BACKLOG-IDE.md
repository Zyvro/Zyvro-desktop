# Ce qui manque pour être à la hauteur de VS Code et de Cursor

La liste de travail de l'amélioration continue : une entrée à la fois, la plus
utile d'abord, une version taguée à chaque entrée livrée. Tenue à jour à chaque
itération — ce qui est fait descend dans « Livré », avec sa version.

L'ordre est celui de l'impact pour quelqu'un qui passe ses journées dedans,
rapporté à l'effort. Les bugs qui perdent du travail passent devant tout.

## À faire

1. **Sauvegarde automatique** (après un délai, ou au changement d'onglet),
   désactivée par défaut.
2. **Réglages.** Taille de police, tabulation, retour à la ligne, minimap —
   aujourd'hui en dur dans `CodeEditor.tsx`.
3. **Onglet d'aperçu en italique, et épinglage** par double-clic.
4. **Réordonner les onglets en les glissant.**
5. **Aperçu Markdown**, avec le rendu déjà utilisé par le chat.
6. **Sélection multiple dans l'arbre** (Cmd/Maj-clic), que le glisser-déposer
    sait déjà transporter.
7. **Panneau Problems et plan du fichier**, depuis les marqueurs de Monaco.
8. **Terminal : effacer (Cmd+K) et scinder.**
9. **Éditeurs côte à côte et fil d'Ariane.**
10. **Un graphe modifié demande aussi avant de fermer**, comme un fichier.

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
- **0.1.0-alpha.9 — palette de commandes (⇧⌘P).** La même boîte que ⌘P, `>`
  en tête. Elle lit le menu de l'application au principal (`main/menulist`)
  et passe par lui pour agir : une seule liste, un seul endroit où écrire un
  raccourci.
- **0.1.0-alpha.9 — la barre d'état de l'éditeur.** Ln/Col et sélection,
  indentation, LF/CRLF, langue ; chacun cliquable (Go to Line, bascule des
  fins de ligne, choix de l'indentation).
- **0.1.0-alpha.9 — le clic droit sur un onglet.** Close, Close Others, Close to
  the Right, Close All (une seule question pour tous les fichiers modifiés),
  Copy Path, Copy Relative Path, Reveal in Finder. Et un fichier revenu à son
  texte enregistré n'est plus « modifié ».
- **0.1.0-alpha.10 — l'arbre au clavier, et qui suit le fichier actif.**
  Flèches, Home/End, Entrée, F2, Suppr (⌘⌫) ; le fichier actif se révèle, et
  « Collapse Folders » replie tout. Renommer et supprimer vivent dans
  `lib/entryActions`, partagé avec le clic droit ; supprimer ferme les onglets
  propres du fichier parti.
- **0.1.0-alpha.11 — git dans l'arbre.** Couleur et lettre par fichier (M, U,
  A, D, conflit), point coloré sur les dossiers ; `projectPrefix` pour un
  projet ouvert dans un sous-dossier du dépôt.
