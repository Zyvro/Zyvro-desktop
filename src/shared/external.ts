// Les fichiers hors du projet.
//
// Un fichier lâché depuis le bureau sur l'éditeur, ou choisi par File › Open
// File…, s'ouvre dans un onglet comme un autre, et s'enregistre, comme dans
// VS Code et Cursor. L'onglet le nomme par son chemin absolu, écrit avec des
// `/` — `/Users/x/notes.txt`, `C:/Users/x/notes.txt` — et c'est ce qui le
// distingue d'un fichier du projet, dont le chemin est relatif et ne commence
// jamais ainsi.
//
// Le principal n'ouvre un chemin absolu que s'il l'a accordé : un fichier
// qu'on a lâché ou choisi, pas n'importe quel chemin qu'une page nommerait
// (main/ipc.ts, `grants`). `scripts/check-external.mjs`.

/** Un chemin absolu : `/…`, `C:/…` ou `C:\…`, ou `\\serveur\…`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")
}

/** Le chemin d'un onglet : les `\` de Windows deviennent des `/`. */
export function tabPathOf(absolute: string): string {
  return absolute.replace(/\\/g, "/")
}

/** Le chemin tel que le système l'écrit, pour le copier ou le montrer. */
export function nativePath(p: string, platform: string): string {
  return platform === "win32" ? p.replace(/\//g, "\\") : p
}

// Le texte d'un fichier « binaire ». Cursor et VS Code ne l'ouvrent pas d'office
// — un exécutable décodé en UTF-8 est illisible, et l'enregistrer le détruit —
// mais « Open Anyway » l'ouvre quand même : parfois c'est un texte dans un
// encodage exotique, ou un NUL égaré dans un journal. Jusqu'à cette taille ;
// au-delà, l'éditeur n'y survivrait pas.
export const FORCE_MAX_BYTES = 50 * 1024 * 1024
