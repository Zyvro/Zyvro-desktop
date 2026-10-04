// Combien de temps un tour a pris, et à quelle heure il a fini.
//
// La forme est celle du terminal de Claude Code : « 3s », « 1m 12s »,
// « 1h 4m » — assez pour savoir si on attend encore, sans décimales qui
// tremblent à chaque seconde.

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

/** L'heure de fin, sur 24 heures : « 23:55 ». */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
