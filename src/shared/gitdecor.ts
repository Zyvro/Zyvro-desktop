// Ce que git dit de chaque fichier, tel que l'arbre l'affiche.
//
// VS Code colore le nom d'un fichier modifié et écrit sa lettre à droite — M,
// U, A, D — et colore aussi les dossiers qui en contiennent, d'un point. C'est
// ce qui permet de voir, sans ouvrir le panneau Git, où l'on a travaillé.
//
// Pur : les changements du dépôt en entrée, une carte chemin → décoration en
// sortie, en chemins relatifs au *projet*. `scripts/check-gitdecor.mjs`.

export type Tone = "modified" | "added" | "deleted" | "conflicted"

export type Decoration = { letter: string; tone: Tone }

type ChangeLike = { path: string; status: string; letter: string }

// Qui l'emporte quand un fichier est à la fois dans l'index et dans l'arbre de
// travail, et quelle couleur un dossier prend de ses enfants : le conflit
// d'abord — c'est la seule chose à régler avant tout le reste —, puis ce qui
// disparaît, puis ce qui change, puis ce qui arrive.
const RANG: Record<Tone, number> = { conflicted: 4, deleted: 3, modified: 2, added: 1 }

function toneOf(status: string): Tone | null {
  switch (status) {
    case "conflicted":
      return "conflicted"
    case "deleted":
      return "deleted"
    case "modified":
    case "type-changed":
      return "modified"
    case "added":
    case "untracked":
    case "renamed":
    case "copied":
      return "added"
    default:
      return null
  }
}

// La lettre de VS Code : U pour un fichier que git ne suit pas encore, là où
// `git status --short` écrit `??`.
function letterOf(status: string, letter: string): string {
  if (status === "untracked") return "U"
  if (status === "conflicted") return "!"
  return letter || "M"
}

export function decorations(
  changes: ChangeLike[],
  projectPrefix: string
): { files: Map<string, Decoration>; folders: Map<string, Tone> } {
  const files = new Map<string, Decoration>()
  const folders = new Map<string, Tone>()
  const prefixe = projectPrefix ? `${projectPrefix.replace(/\/+$/, "")}/` : ""

  for (const change of changes) {
    // Hors du projet ouvert — un sous-dossier d'un plus grand dépôt : pas une
    // ligne de cet arbre.
    if (prefixe && !change.path.startsWith(prefixe)) continue
    const path = change.path.slice(prefixe.length)
    const tone = toneOf(change.status)
    if (!tone || !path) continue

    const avant = files.get(path)
    if (!avant || RANG[tone] > RANG[avant.tone]) {
      files.set(path, { letter: letterOf(change.status, change.letter), tone })
    }

    // Chaque dossier au-dessus prend la couleur la plus grave de ce qu'il
    // contient.
    const parts = path.split("/")
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join("/")
      const deja = folders.get(dir)
      if (!deja || RANG[tone] > RANG[deja]) folders.set(dir, tone)
    }
  }
  return { files, folders }
}
