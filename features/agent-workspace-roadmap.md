# Zyvro : piloter des agents qui travaillent sur des projets

État : propositions issues de la passe du 4 octobre 2026. Les sections ci-dessous
ne sont pas des fonctionnalités livrées. La passe courte traite les problèmes
reproductibles et la navigation ; elle ne lance aucun agent payant pour explorer
le produit.

## Livré dans cette passe, avant publication

- `/login` et `/auth` ouvrent l'authentification du CLI dans un terminal dédié.
- Mise à jour Windows : vérification du démarrage du programme d'installation,
  gestion des processus restant dans `resources`, restauration et relance.
- Recherche des sessions du projet par titre, harnais ou modèle ; filtre des
  agents en cours ; indication des messages en attente ; renommage sauvegardé.
- Actions agents dans la palette ; ouverture native dans un terminal dédié.
- Réponses aux questions conservées en cas d'échec d'envoi et lors d'un
  changement de projet ; sauvegardes de conversations sérialisées par projet.
- Téléchargements interrompus nettoyés, erreurs disque traitées, préparation de
  mise à jour visible et protection contre les doubles installations.
- Envoi d'une image seule, respect de la composition IME, navigation Quick Open
  lors du chargement et conservation du chemin des fichiers fermés après renommage.
- Une reformulation lente conserve les brouillons modifiés entre-temps et ne
  déclenche aucun envoi si l'utilisateur a changé de session ou de projet.

## P0 — Fiabilité des agents en arrière-plan

**Problème observé dans le code.** `AgentPanel.mapThread` retrouve les fils rangés
par projet, mais `threadById` ne lit que le projet affiché. `persist`, `advance`
et `steered` passent par cette seconde fonction. Le flux peut donc continuer
à l'écran au retour dans le projet, alors que sa sauvegarde ou la suite de la
file n'ont pas suivi. Dans le principal, `agent:remember` et `agent:send` utilisent
le projet actif de la fenêtre. Élargir seulement `threadById` risquerait alors
d'écrire ou d'envoyer dans le mauvais projet.

**Implémentation à prévoir comme un ensemble.** Attacher chaque conversation et
chaque envoi au projet d'origine, validé parmi les projets ouverts par le processus
principal. Utiliser ce même contexte pour les outils, les modèles, la sauvegarde
et la file. Ne jamais changer silencieusement le projet actif pour envoyer un
message en arrière-plan. Conserver l'association pendant les réponses asynchrones,
la reprise des sessions et les réveils planifiés.

**Critères de validation.** Démarrer A, passer dans B, recevoir les sorties et
une réponse de pilotage de A, terminer A, relire le transcript sur disque et
vérifier que B n'a reçu ni messages ni fichiers. Répéter avec un envoi en file,
un réveil programmé, une fermeture de projet et un rechargement de fenêtre.

## P1 — Boîte de réception commune aux projets

**Usage.** Je lance des agents sur plusieurs projets et je veux voir celui qui
attend une réponse, celui qui a échoué et celui qui a terminé, sans visiter
chaque onglet.

- Une vue Agents regroupe les sessions par projet, avec recherche et filtres :
  En cours, Attend une réponse, À relire, En erreur, Planifiées.
- Les événements de permission/question portent explicitement l'identifiant
  du tour et de la conversation. Les demandes actuelles sont globales à la fenêtre :
  il faut d'abord cette corrélation pour afficher « attend une réponse » honnêtement.
- Cliquer rejoint le bon projet et le bon fil. Arrêter vise un tour précis.
- Un compteur de travaux terminés reste discret ; pas de notifications à chaque
  token. Les intitulés et états sont lisibles au clavier et au lecteur d'écran.

**Dépendance.** P0, puis un magasin de sessions indépendant du montage d'AgentPanel.

## P1 — Archiver plutôt que supprimer en fermant un onglet

**Usage.** Je termine une tâche et dégage l'espace sans perdre la conversation.
La croix actuelle supprime le transcript, après confirmation. Prévoir un état
archivé durable, une vue « Archives », et une action de suppression distincte.
Fermer un agent actif doit expliciter s'il continue ou s'arrête. Les brouillons,
pièces jointes et identifiants natifs du harnais restent rattachés à la session.

**Validation.** Archiver, relancer l'application, retrouver puis reprendre le même
fil. Une purge ne doit supprimer que la session choisie et ses pièces jointes.

## P1 — Relire les modifications produites par un agent

**Usage.** Avant d'accepter le travail, je veux voir le résultat, ses fichiers et
ses vérifications, pas reconstruire cela à partir du transcript.

Prévoir un résumé de fin de tâche avec fichiers modifiés et lien vers les diffs,
commandes de validation et résultats, erreurs éventuelles, coût quand le harnais
le fournit. Un snapshot Git au départ peut aider, mais il faut distinguer les
modifications déjà présentes de celles de l'agent. Pas de bouton « annuler tout »
qui écrase les changements de l'utilisateur ou d'un autre agent.

## P1 — Isolation par worktree pour les tâches concurrentes

**Usage.** Deux agents sur le même dépôt doivent pouvoir travailler sans écraser
leurs fichiers. Proposer une tâche dans le dossier courant ou un worktree isolé.
Afficher branche et dossier en permanence, puis proposer comparaison, tests et
intégration. Traiter les dépôts sans commit, sous-modules, modifications locales,
conflits et nettoyages de worktrees encore utilisés par un terminal/processus.

**Limite de la passe courte.** Cela change le contexte des CLI, du moteur, des
terminaux et de Git : une simple création de branche ne suffit pas.

## P2 — Tâches planifiées durables et bornées

**Usage.** « Pendant une heure, corrige de petits bugs » et « chaque heure,
vérifie les échecs » sont deux demandes différentes. La création doit montrer
heure de départ, durée limite, fréquence éventuelle, agent, projet, permission
et plafond de dépense lorsqu'il est disponible.

Lister les prochaines exécutions et les dernières sorties. Pause, reprise,
annulation, absence de rattrapage automatique des tours manqués, aucune double
exécution après redémarrage. Les réveils existants sont une base, pas encore un
ordonnanceur durable avec une politique de budget.

## P2 — État des connexions et compatibilité des CLI

Après la connexion, afficher le compte quand le CLI sait le fournir, sans copier
les jetons dans le renderer. Distinguer l'authentification native d'un fournisseur
externe choisi dans Zyvro. Détecter la version installée et les capacités :
commandes interactives, Chrome, MCP, questions et pilotage en cours de tour.
La mise à jour du CLI doit utiliser sa méthode d'installation, sans installer une
seconde copie concurrente. Voir aussi les documents `features/harness-updates.md`
et `features/slash-commands.md` dans le dossier projet parent.

## Repères pris dans VS Code

Les [sessions](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions)
et la [fenêtre Agents](https://code.visualstudio.com/docs/agents/run/agents-window)
mettent en avant l'affectation du travail, son état et la revue du résultat.
La [palette et la navigation clavier](https://code.visualstudio.com/docs/editing/getting-started/userinterface)
rendent ces actions accessibles sans accumuler les boutons.

L'adaptation à Zyvro garde les harnais natifs et les graphes de workflows comme
outils des agents. Le cap est un poste de pilotage du travail sur les projets,
avec des résultats vérifiables et une maîtrise explicite des exécutions.
