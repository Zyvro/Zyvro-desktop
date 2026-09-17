// Lire ce qu'on vient de lâcher.
//
// Deux sources, un seul résultat. Un fichier attrapé dans le Finder arrive
// comme un `File` — dont le chemin ne s'obtient que par le pont, `File.path`
// n'existant plus depuis Electron 32. Un fichier attrapé dans l'arbre de
// l'application arrive comme du texte, sous un type à nous.
//
// Les deux panneaux qui acceptent un dépôt — le chat et le terminal — doivent
// lire les deux de la même façon, sinon l'un des deux n'acceptera qu'une
// moitié des gestes possibles, et ce sera celui que la personne essaiera.
//
// Séparé du module partagé parce que ceci touche au DOM : `DataTransfer` n'a
// pas de sens dans le processus principal, et la citation des chemins, si.
//
// Les deux fonctions acceptent aussi bien l'événement synthétique de React que
// l'événement natif : le terminal doit écouter en natif — son DOM est celui de
// xterm, pas celui de React, et React ne distribue pas les dépôts qui y
// naissent — et un second jeu de lecteurs pour cette raison-là serait un
// endroit de plus où oublier une des deux sources.

import { ZYVRO_PATH, pathsFromText } from "../../shared/dropped"

type Carrier = Pick<DataTransfer, "types" | "files" | "getData">

// carriesPaths : « ce dépôt désigne-t-il des fichiers ».
//
// Posée avant `preventDefault`, parce qu'un survol qu'on intercepte est un
// dépôt qu'on promet d'accepter : le faire pour du texte quelconque
// empêcherait le champ de recevoir ce que le navigateur y met très bien tout
// seul.
export function carriesPaths(event: { dataTransfer: Carrier | null }): boolean {
  if (!event.dataTransfer) return false
  const types = [...event.dataTransfer.types]
  return types.includes("Files") || types.includes(ZYVRO_PATH)
}

// droppedPaths rend les chemins absolus de ce qui a été lâché, dans l'ordre.
export function droppedPaths(event: { dataTransfer: Carrier | null }): string[] {
  if (!event.dataTransfer) return []
  const types = [...event.dataTransfer.types]
  if (types.includes(ZYVRO_PATH)) {
    return pathsFromText(event.dataTransfer.getData(ZYVRO_PATH))
  }
  return [...event.dataTransfer.files]
    .map((file) => window.zyvro.files.droppedPath(file))
    .filter(Boolean)
}
