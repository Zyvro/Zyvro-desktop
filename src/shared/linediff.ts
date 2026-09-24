// Les lignes qui ont changé depuis le dernier commit, pour la marge de l'éditeur.
//
// VS Code colore la gouttière : une barre verte pour ce qui est ajouté, bleue
// pour ce qui est modifié, un petit triangle rouge là où des lignes ont été
// supprimées. On voit ce qu'on a touché sans ouvrir de diff.
//
// Un diff de lignes à la Myers, après avoir retiré le début et la fin
// communs — l'immense majorité d'un fichier qu'on édite, ce qui ramène le
// travail à la zone touchée. Pur : `scripts/check-linediff.mjs`.

export type LineChange = {
  kind: "added" | "modified" | "deleted"
  /** Lignes du texte actuel, comptées à partir de 1, fin incluse. Pour une
   *  suppression, la ligne après laquelle quelque chose a disparu (0 : tout
   *  en haut). */
  start: number
  end: number
}

// Au-delà, on renonce : un diff qui coûterait des secondes à chaque frappe ne
// vaut pas une gouttière colorée. Un fichier réécrit de bout en bout n'a pas
// besoin qu'on lui dise qu'il a changé.
const MAX_EDIT = 2000

type Op = { kind: "equal" | "insert" | "delete"; count: number }

// myers : la suite d'opérations la plus courte de `a` vers `b`, ou null si
// elle dépasse MAX_EDIT.
function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDIT)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // Pour chaque étape d, seulement la fenêtre utile de v : les diagonales
  // -d-1..d+1. Garder le tableau entier à chaque étape coûtait
  // (2·max)·max entiers — 128 Mo pour un fichier réécrit.
  const traces: Int32Array[] = []
  let fini = -1
  for (let d = 0; d <= max; d++) {
    traces.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        fini = d
        break
      }
    }
    if (fini >= 0) break
  }
  if (fini < 0) return null

  // Remonter le chemin, du bout vers le début.
  const ops: Op["kind"][] = []
  let x = n
  let y = m
  for (let d = fini; d > 0; d--) {
    // traces[d] commence à la diagonale -d-1.
    const vd = traces[d]
    const at = (kk: number) => vd[kk + d + 1]
    const k = x - y
    const versLeHaut = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const kAvant = versLeHaut ? k + 1 : k - 1
    const xAvant = at(kAvant)
    const yAvant = xAvant - kAvant
    while (x > xAvant && y > yAvant) {
      ops.push("equal")
      x--
      y--
    }
    if (versLeHaut) {
      ops.push("insert")
      y--
    } else {
      ops.push("delete")
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push("equal")
    x--
    y--
  }
  ops.reverse()

  const out: Op[] = []
  for (const kind of ops) {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.count++
    else out.push({ kind, count: 1 })
  }
  return out
}

function lignes(text: string): string[] {
  if (text === "") return []
  const l = text.split(/\r?\n/)
  // Une fin de fichier en `\n` ne fait pas une ligne vide de plus à comparer.
  if (l.length > 1 && l[l.length - 1] === "") l.pop()
  return l
}

export function lineChanges(before: string, after: string): LineChange[] {
  const a = lignes(before)
  const b = lignes(after)

  let debut = 0
  while (debut < a.length && debut < b.length && a[debut] === b[debut]) debut++
  let fin = 0
  while (fin < a.length - debut && fin < b.length - debut && a[a.length - 1 - fin] === b[b.length - 1 - fin]) fin++

  const ops = myers(a.slice(debut, a.length - fin), b.slice(debut, b.length - fin))
  if (!ops) {
    // Trop différent pour valoir un diff : tout ce qui reste est « modifié ».
    const s = debut + 1
    const e = b.length - fin
    return e >= s ? [{ kind: "modified", start: s, end: e }] : [{ kind: "deleted", start: debut, end: debut }]
  }

  const out: LineChange[] = []
  let ligne = debut // lignes du texte actuel déjà parcourues
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (op.kind === "equal") {
      ligne += op.count
      continue
    }
    // Une suppression suivie d'un ajout (ou l'inverse) est une modification.
    const suivant = ops[i + 1]
    const paire = suivant && suivant.kind !== "equal" && suivant.kind !== op.kind
    const ajoutes = (op.kind === "insert" ? op.count : 0) + (paire && suivant.kind === "insert" ? suivant.count : 0)
    const supprimes = (op.kind === "delete" ? op.count : 0) + (paire && suivant.kind === "delete" ? suivant.count : 0)
    if (paire) i++
    if (ajoutes > 0 && supprimes > 0) {
      out.push({ kind: "modified", start: ligne + 1, end: ligne + ajoutes })
    } else if (ajoutes > 0) {
      out.push({ kind: "added", start: ligne + 1, end: ligne + ajoutes })
    } else {
      out.push({ kind: "deleted", start: ligne, end: ligne })
    }
    ligne += ajoutes
  }
  return out
}
