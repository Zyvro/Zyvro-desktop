// Un fichier déposé depuis le Finder, mis en texte.
//
// Le geste est le même dans les deux panneaux — on attrape un fichier dans le
// Finder, on le lâche sur le chat ou sur le terminal — et ce qu'on veut est son
// chemin, écrit là où était le curseur.
//
// La mise entre guillemets n'est pas une politesse. Dans un terminal, le texte
// déposé est exécuté tel quel, et un nom de fichier est un texte que quelqu'un
// d'autre a écrit : `mon fichier.txt` devient deux arguments, et un fichier
// nommé `$(rm -rf ~).txt` — ce qui est un nom de fichier parfaitement légal —
// devient une commande. Les apostrophes simples d'un shell POSIX ne laissent
// rien s'échapper, ce qui est exactement ce qu'on veut ici ; Windows n'a pas
// d'équivalent aussi net, et ses guillemets doubles sont ce que `cmd` et
// PowerShell comprennent tous les deux.
//
// Partagé entre le processus principal, le pont et le rendu parce que les deux
// panneaux doivent écrire la même chose : un chemin cité d'un côté et brut de
// l'autre, ce serait le terminal qui casse, et seulement pour les gens dont les
// dossiers ont des espaces.

// SAFE est ce qui n'a besoin de rien : lettres, chiffres, et la ponctuation
// qu'un chemin porte sans qu'aucun shell n'y touche. Tout le reste est cité —
// y compris les accents, qui n'en auraient pas besoin mais qu'il est moins
// coûteux de citer que de raisonner.
const SAFE = /^[A-Za-z0-9_@%+=:,.\/~-]+$/

export function quotePath(value: string, platform: string): string {
  const trimmed = value.trim()
  if (trimmed === "") return ""
  if (SAFE.test(trimmed)) return trimmed
  if (platform === "win32") {
    // `cmd` n'a pas d'échappement à l'intérieur des guillemets : doubler le
    // guillemet est la convention que lui et PowerShell acceptent.
    return `"${trimmed.replace(/"/g, '""')}"`
  }
  // Rien ne s'interprète entre apostrophes simples, pas même une apostrophe :
  // on la ferme, on l'échappe, on la rouvre.
  return `'${trimmed.replace(/'/g, "'\\''")}'`
}

// droppedText : plusieurs fichiers d'un coup, séparés par une espace, dans
// l'ordre où on les a lâchés.
export function droppedText(paths: string[], platform: string): string {
  return paths
    .map((p) => quotePath(p, platform))
    .filter(Boolean)
    .join(" ")
}

// insertAt : le texte déposé arrive là où était le curseur, pas à la fin.
//
// Rendue ici plutôt qu'écrite dans le panneau parce que les deux moitiés —
// le texte et la nouvelle position du curseur — se calculent ensemble, et
// qu'une des deux oubliée laisse le curseur au début.
export function insertAt(
  value: string,
  start: number,
  end: number,
  inserted: string
): { value: string; cursor: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  // Une espace avant, s'il n'y en a pas déjà : sans elle, un chemin lâché à la
  // suite d'un mot se colle dedans.
  const gap = before === "" || /\s$/.test(before) ? "" : " "
  const text = `${before}${gap}${inserted}${after}`
  return { value: text, cursor: before.length + gap.length + inserted.length }
}

// ZYVRO_PATH est le type que l'arbre de fichiers pose sur ce qu'on y attrape.
//
// Un type à nous, en plus du `text/plain` habituel, pour une raison précise :
// on veut savoir qu'un dépôt est une désignation de fichier et pas un texte
// quelconque. Sans lui, une phrase glissée depuis une page web arriverait dans
// le terminal entre apostrophes, ce qui n'a aucun sens — et le `text/plain`
// reste posé quand même, pour que lâcher le fichier dans une autre application
// écrive son chemin comme n'importe qui l'attend.
export const ZYVRO_PATH = "application/x-zyvro-path"

// pathsFromText lit ce que l'arbre a posé : un chemin par ligne.
//
// Plusieurs lignes parce qu'une sélection multiple viendra, et qu'un format qui
// n'accepte qu'un chemin aujourd'hui serait à changer des deux côtés ce
// jour-là.
export function pathsFromText(text: string): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
