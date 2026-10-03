# Capture d'écran depuis la barre de menus

Une icône Zyvro dans la barre de menus (macOS) ou la zone de notification
(Windows) : on choisit une zone de l'écran, en image ou en vidéo d'une minute
au plus, et une petite fenêtre propose de la copier, de la garder ou de la
publier — un lien public qui dure 24 heures.

## Le parcours

1. Clic sur l'icône, ou raccourci global :
   - **Capture Area** — ⌘⇧2 / Ctrl+Shift+2 ;
   - **Record Area (up to 1 min)** — ⌘⌥⇧2 / Ctrl+Alt+Shift+2, le même pour
     arrêter.
2. La zone :
   - image sous macOS : la sélection du système (`screencapture -i`) —
     réticule, Espace pour une fenêtre, Échap pour annuler ;
   - vidéo, et tout sous Windows : une fenêtre transparente par écran, sur
     laquelle on trace la zone. Échap ou clic droit annule.
3. Pendant un enregistrement : un cadre rouge autour de la zone et une pastille
   « 0:12 / 1:00 · Stop », tous deux exclus de la capture. La barre de menus
   macOS montre le temps écoulé ; l'icône Windows prend un point rouge et un
   clic dessus arrête. L'enregistrement s'arrête seul à une minute.
4. La fenêtre de résultat, près de l'icône :
   - image : **Copy**, **Save…** ;
   - vidéo : **Save WebM…**, **Save GIF…** ;
   - **Publish Online** : envoie, met le lien dans le presse-papier, montre le
     lien (et celui du GIF pour une vidéo) avec l'heure d'expiration ;
   - sans compte connecté, elle invite à ouvrir Studio pour se connecter.

## Les réglages

Settings › Screen capture, gardés par le processus principal
(`userData/capture.json`) puisque l'icône vit sans fenêtre :

- les deux raccourcis, essayés auprès du système ; un raccourci déjà pris
  l'est dit ;
- **Keep a copy of every capture** : un dossier où chaque capture est copiée
  (PNG, ou WebM + GIF) ;
- **Start at login** : non par défaut. La question est posée une fois, après la
  première capture. L'app démarre alors en arrière-plan, sans fenêtre
  (`--background`, ou `wasOpenedAtLogin` sous macOS). Pas proposé en
  développement.

Sous Windows, fermer la dernière fenêtre ne quitte plus l'app : elle reste dans
la zone de notification (dit une fois, par une bulle). **Quit Zyvro Studio**
dans le menu de l'icône la ferme.

## Vidéo et GIF

L'enregistreur est une fenêtre cachée : `getDisplayMedia` sur l'écran choisi
(la session de l'enregistreur ne sait donner que celui-là), recadrage dans une
toile, `MediaRecorder` en WebM (VP9, sinon VP8) à 4 Mbit/s, plus grand côté
1920 et côtés pairs.

Le GIF est fait **sur la machine**, au fil de l'enregistrement (`gifenc`,
`src/shared/gifclip.ts`) : 10 images/s, 640 px de large au plus. Chaque image
ne réécrit que les pixels qui ont changé, le reste est transparent ; une image
où rien n'a bougé ne s'écrit pas. Les délais sont les vrais, le GIF dure ce
qu'a duré l'enregistrement. Au-delà de 38 Mo, pas de GIF : seule la vidéo est
publiée, et la fenêtre le dit.

Pourquoi pas sur le serveur : il faudrait ffmpeg là-bas et un processeur à
chaque téléchargement, pour un fichier dont la machine a déjà les images.

## Le serveur

`POST /api/shots` (`Zyvro-backend/api/shots.go`), séparé de `/api/uploads` :
les pièces jointes du chat vivent dans `uploads` et doivent durer autant que la
conversation. Une purge à 24 h là-bas aurait cassé l'historique.

- `file` : PNG, JPEG, GIF, WebP (20 Mo) ou WebM (40 Mo) ; `gif` : facultatif,
  avec un WebM seulement (40 Mo).
- La durée est **lue dans les octets** : les timestamps des clusters WebM (y
  compris ceux sans taille qu'écrit un enregistreur en direct), la somme des
  délais du GIF. Au-delà de 60 s (+2 s de marge), refusé.
- 500 Mo par compte au plus en même temps.
- Réponse : `url`, `gif_url` (avec `?download=1`, servi en pièce jointe),
  `expires_at`.
- `/content/shots/…` répond 410 dès 24 h, même avant la purge, ne se met jamais
  en cache au-delà de l'expiration, et accepte les requêtes `Range` (une vidéo
  se parcourt).
- `StartShotRetention` efface le dossier `shots` toutes les heures, et lui seul.

## Ce qui protège quoi

- **Ce n'est pas un outil de l'agent.** Les fenêtres de capture sont marquées
  (`src/main/windows.ts`) ; le serveur de captures de l'agent, les questions de
  permission et le cycle de vie ne voient que `studioWindows()`. Sinon un agent
  photographiant « les fenêtres de l'app » aurait reçu l'écran de la personne.
- Un pont à part (`src/preload/capture.ts`), des opérations nommées ; le
  processus principal vérifie que chacune vient de la fenêtre qui y a droit.
- Le presse-papier ne reçoit que les liens que le serveur a rendus pour cette
  capture, et seulement en http(s).

`scripts/check-capture.mjs` vérifie tout cela, plus la géométrie (Retina,
bords) et la durée réelle du GIF.

## Limites connues

- **macOS, permission « Enregistrement de l'écran ».** Demandée une fois ; sans
  elle on le dit avant de capturer. L'app est signée ad hoc
  (`electron-builder.yml`) : la signature change à chaque version, et macOS
  peut redemander la permission après une mise à jour. Une signature Developer
  ID réglerait ça.
- **Le WebM d'un enregistreur en direct n'a pas de durée dans son en-tête** :
  il se lit partout, mais certains lecteurs affichent une barre de progression
  sans fin. Le serveur, lui, mesure la durée sur les images.
- **Pas encore essayé à la main** : la sélection, la pastille et l'icône ont été
  vérifiées hors écran, pas cliquées. Windows et ses écrans à DPI mélangés
  restent à tester sur une vraie machine.
