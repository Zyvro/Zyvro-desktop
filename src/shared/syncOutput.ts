// Le mode « sortie synchronisée » (DEC 2026) et la cadence d'écriture d'un terminal.
//
// Les interfaces plein écran d'agents (Qwen Code, Claude Code, codex : toutes bâties
// sur Ink) ne mettent pas leur écran à jour par petites touches : à chaque image elles
// EFFACENT leur zone dynamique ligne par ligne puis la RÉÉCRIVENT en entier, ce qui,
// pour une réponse qui défile, fait plusieurs images par seconde de plusieurs
// kilo-octets. Pour que le terminal n'en peigne pas l'état intermédiaire — écran à
// moitié effacé —, elles encadrent chaque image de `ESC[?2026h` … `ESC[?2026l` : « ne
// dessine qu'une fois que j'ai fini ».
//
// xterm.js 5.5 ne connaît pas ce mode. Il lit les octets au fil de leur arrivée et
// peint à chaque image d'animation, souvent au beau milieu d'une image de l'agent :
// le texte disparaît et revient dix fois par seconde. Relevé sur Qwen Code 0.25 : 166
// images synchronisées et plus de 5 000 effacements de ligne pour une réponse de
// quarante lignes.
//
// Ce module est la partie manquante, pure et sans xterm : il retient ce qui est
// entre les deux repères, rend l'image d'un bloc, et groupe le reste à la cadence de
// l'écran (une écriture par image d'animation, pas une par morceau reçu).
//
// Ce qui casse en silence ici, et que `scripts/check-terminal-output.mjs` vérifie :
//
// 1. **Un repère coupé en deux** par la frontière de deux morceaux reçus.
// 2. **Une image jamais fermée** (l'agent meurt entre `h` et `l`) : le terminal
//    resterait figé. Un délai ferme de force.
// 3. **Des octets perdus ou réordonnés** : c'est une sortie de terminal, un octet
//    manquant décale tout l'écran.
// 4. **Une mémoire qui grossit** quand la fenêtre est cachée et que rien ne la vide.

export const SYNC_BEGIN = "\x1b[?2026h"
export const SYNC_END = "\x1b[?2026l"
const MARKER_PREFIX = "\x1b[?2026"

export type Scheduler = {
  /** À la prochaine image d'animation (ou peu après si l'écran n'en fait plus). */
  frame: (fn: () => void) => () => void
  /** Après ce délai, en millisecondes. */
  after: (ms: number, fn: () => void) => () => void
}

export type SyncOutputOptions = {
  /** Combien de temps une image synchronisée peut rester ouverte avant d'être rendue de force. */
  holdMs?: number
  /** Au-delà, on rend sans attendre : la mémoire ne grossit pas indéfiniment. */
  maxBytes?: number
}

export class SyncOutput {
  private ready = ""
  private held = ""
  private tail = ""
  private inSync = false
  private cancelFrame: (() => void) | null = null
  private cancelHold: (() => void) | null = null
  private disposed = false
  private readonly holdMs: number
  private readonly maxBytes: number

  constructor(
    private readonly sink: (data: string) => void,
    private readonly scheduler: Scheduler,
    options: SyncOutputOptions = {}
  ) {
    this.holdMs = options.holdMs ?? 120
    this.maxBytes = options.maxBytes ?? 1 << 20
  }

  /** Une image est-elle ouverte en ce moment ? (pour les vérifications) */
  get open(): boolean {
    return this.inSync
  }

  push(data: string): void {
    if (this.disposed || data === "") return
    let rest = this.tail + data
    this.tail = ""
    while (rest !== "") {
      const at = rest.indexOf(MARKER_PREFIX)
      if (at === -1) {
        // Pas de repère : mais la fin du morceau peut en être le début.
        const keep = partialMarkerLength(rest)
        this.append(keep > 0 ? rest.slice(0, rest.length - keep) : rest)
        this.tail = keep > 0 ? rest.slice(rest.length - keep) : ""
        break
      }
      if (at > 0) this.append(rest.slice(0, at))
      const end = at + MARKER_PREFIX.length
      if (end >= rest.length) {
        // Le repère est coupé juste avant son dernier caractère.
        this.tail = rest.slice(at)
        break
      }
      const mode = rest[end]
      if (mode === "h") this.begin()
      else if (mode === "l") this.finish()
      // Autre chose (une interrogation `ESC[?2026$p`…) : ce n'est pas un repère, on le laisse passer.
      else this.append(rest.slice(at, end + 1))
      rest = rest.slice(end + 1)
    }
    this.settle()
  }

  /** Tout rendre maintenant, image ouverte comprise. À appeler avant d'écrire autre chose dans le terminal. */
  flushNow(): void {
    if (this.inSync) this.finish()
    this.emit()
  }

  dispose(): void {
    this.disposed = true
    this.cancelFrame?.()
    this.cancelHold?.()
    this.ready = this.held = this.tail = ""
  }

  private append(text: string): void {
    if (text === "") return
    if (this.inSync) this.held += text
    else this.ready += text
  }

  private begin(): void {
    if (this.inSync) return
    this.inSync = true
    // Une image qui ne se ferme pas ne doit pas figer l'écran : l'agent a pu mourir en chemin.
    this.cancelHold?.()
    this.cancelHold = this.scheduler.after(this.holdMs, () => {
      this.cancelHold = null
      if (this.inSync) {
        this.finish()
        this.settle()
      }
    })
  }

  private finish(): void {
    this.inSync = false
    this.cancelHold?.()
    this.cancelHold = null
    this.ready += this.held
    this.held = ""
  }

  private settle(): void {
    // Une image démesurée est rendue de force. Une image ouverte, sinon, attend sa fin —
    // mais ce qui la PRÉCÈDE est un écran complet, et il se rend à l'image d'animation.
    if (this.inSync && this.held.length > this.maxBytes) this.finish()
    if (this.ready === "") return
    if (this.ready.length > this.maxBytes) {
      this.emit()
      return
    }
    if (this.cancelFrame) return
    this.cancelFrame = this.scheduler.frame(() => {
      this.cancelFrame = null
      this.emit()
    })
  }

  private emit(): void {
    if (this.ready === "") return
    const out = this.ready
    this.ready = ""
    this.cancelFrame?.()
    this.cancelFrame = null
    this.sink(out)
  }
}

// Combien de caractères de la fin de `text` pourraient être le début d'un repère.
function partialMarkerLength(text: string): number {
  const max = Math.min(MARKER_PREFIX.length, text.length)
  for (let n = max; n > 0; n--) {
    if (MARKER_PREFIX.startsWith(text.slice(text.length - n))) return n
  }
  return 0
}
