// Les onglets du terminal, et les shells côte à côte dans un onglet.
//
// Comme VS Code : « Split Terminal » ouvre un shell de plus à côté de celui
// qu'on regarde, dans le même onglet ; fermer l'un laisse les autres. Un onglet
// est un groupe de shells, dans l'ordre où on les voit, de gauche à droite.
//
// Pur, sur des clés de session : pas de xterm, pas de pty.
// `scripts/check-termgroups.mjs`.

export type Groups = string[][]

export function groupOf(groups: Groups, key: string): string[] | null {
  return groups.find((g) => g.includes(key)) ?? null
}

/** Un onglet de plus, un shell dedans. */
export function addGroup(groups: Groups, key: string): Groups {
  return [...groups, [key]]
}

/** Un shell de plus à droite de `beside`, dans son onglet ; un onglet neuf s'il n'y en a pas. */
export function splitBeside(groups: Groups, beside: string, key: string): Groups {
  const i = groups.findIndex((g) => g.includes(beside))
  if (i < 0) return addGroup(groups, key)
  const g = groups[i]
  const j = g.indexOf(beside)
  const next = [...g.slice(0, j + 1), key, ...g.slice(j + 1)]
  return groups.map((x, k) => (k === i ? next : x))
}

// removeKey : le shell parti, et celui qui prend la main s'il était actif — son
// voisin dans l'onglet, sinon le premier shell de l'onglet d'à côté.
export function removeKey(groups: Groups, key: string): { groups: Groups; fallback: string } {
  const i = groups.findIndex((g) => g.includes(key))
  if (i < 0) return { groups, fallback: groups[0]?.[0] ?? "" }
  const g = groups[i]
  const j = g.indexOf(key)
  const reste = g.filter((k) => k !== key)
  if (reste.length > 0) {
    return { groups: groups.map((x, k) => (k === i ? reste : x)), fallback: reste[Math.min(j, reste.length - 1)] }
  }
  const sans = groups.filter((_, k) => k !== i)
  return { groups: sans, fallback: sans[Math.min(i, sans.length - 1)]?.[0] ?? "" }
}

// withRestored : les shells repris d'abord, chacun dans son onglet, puis ce qui
// est arrivé pendant qu'on les attendait.
export function withRestored(groups: Groups, keys: string[]): Groups {
  const repris = new Set(keys)
  const autres = groups.map((g) => g.filter((k) => !repris.has(k))).filter((g) => g.length > 0)
  return [...keys.map((k) => [k]), ...autres]
}

// ---- la largeur de chaque shell ----------------------------------------------------

// placeIn : la place du shell `i` de son onglet, en fractions de la largeur,
// d'après la part (le poids) de chacun.
export function placeIn(weights: number[], i: number): { left: number; width: number } {
  const total = weights.reduce((a, b) => a + b, 0) || 1
  const avant = weights.slice(0, i).reduce((a, b) => a + b, 0)
  return { left: avant / total, width: (weights[i] ?? 0) / total }
}

// resizePair : tirer la séparation entre le shell `i` et son voisin de `delta`
// (en unités de poids). Les deux autres ne bougent pas, et aucun des deux ne
// descend sous `min`.
export function resizePair(weights: number[], i: number, delta: number, min: number): number[] {
  const a = weights[i]
  const b = weights[i + 1]
  if (a === undefined || b === undefined) return weights
  const d = Math.max(min - a, Math.min(b - min, delta))
  const out = [...weights]
  out[i] = a + d
  out[i + 1] = b - d
  return out
}
