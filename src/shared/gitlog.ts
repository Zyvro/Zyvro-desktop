// La Timeline d'un fichier : ses commits, du plus récent au plus ancien, et le
// nom qu'il portait à chacun (`git log --follow` suit les renommages).
//
// Pur : lire la sortie de git. `scripts/check-timeline.mjs`.

export type FileCommit = { hash: string; short: string; author: string; date: string; subject: string; path: string }

// Chaque commit commence par \x01, ses champs séparés par NUL, puis
// `--name-only` écrit le chemin du fichier à ce commit sur sa propre ligne.
export const FILE_LOG_FORMAT = "--format=%x01%H%x00%h%x00%an%x00%aI%x00%s"

export function parseFileLog(out: string, fallbackPath: string): FileCommit[] {
  return out
    .split("\x01")
    .map((bloc) => bloc.trim())
    .filter(Boolean)
    .map((bloc) => {
      const [tete, ...reste] = bloc.split("\n")
      const [hash, short, author, date, subject] = tete.split("\0")
      const path = reste.map((l) => l.trim()).find(Boolean) ?? fallbackPath
      return { hash, short, author, date, subject: subject ?? "", path }
    })
    .filter((c) => /^[0-9a-f]{7,64}$/.test(c.hash ?? ""))
}

// « il y a 3 heures », pour la liste ; la date exacte va dans l'infobulle.
export function relativeDate(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, Math.round((now - t) / 1000))
  const unites: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ]
  for (const [taille, nom] of unites) {
    const n = Math.floor(s / taille)
    if (n >= 1) return `${n} ${nom}${n > 1 ? "s" : ""} ago`
  }
  return "just now"
}
