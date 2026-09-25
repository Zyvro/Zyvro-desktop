// Les fichiers du projet que l'éditeur donne à TypeScript.
//
// Monaco vérifie chaque fichier ouvert seul : ⌘-clic ou F12 sur un nom importé
// d'un autre fichier ne menait nulle part, et « Find All References » ne voyait
// que l'onglet. On lui donne donc les sources du projet — comme bibliothèques
// en plus, qui servent aux définitions et aux types sans être vérifiées une à
// une : un millier de fichiers ne doit pas faire tourner le ventilateur.
//
// Pur : choisir quoi, et combien. `scripts/check-project-index.mjs`.

export const INDEX_MAX_FILES = 1500
export const INDEX_MAX_FILE_BYTES = 400 * 1024
export const INDEX_MAX_TOTAL_BYTES = 40 * 1024 * 1024

const SOURCES = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
// Ce qui se construit ou se télécharge, pas ce qu'on écrit.
const DOSSIERS_EXCLUS = new Set(["node_modules", "dist", "out", "build", ".next", ".nuxt", "coverage", ".git", ".turbo", ".cache", "vendor"])

export function selectIndexable(paths: string[], max = INDEX_MAX_FILES): string[] {
  const out: string[] = []
  for (const p of paths) {
    if (!SOURCES.test(p) || /\.min\.js$/i.test(p)) continue
    if (p.split("/").some((seg) => DOSSIERS_EXCLUS.has(seg))) continue
    out.push(p)
    if (out.length >= max) break
  }
  return out
}
