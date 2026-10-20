import type { Scheduler } from "../../shared/syncOutput"

// L'horloge de SyncOutput dans une fenêtre : une écriture par image d'animation, avec
// un filet. `requestAnimationFrame` s'arrête quand la fenêtre est réduite ou cachée, et
// un terminal qui ne vide plus sa file pendant ce temps grossirait sans fin ; le délai
// de 50 ms rend la main dans ce cas, et la première des deux horloges gagne.
export const frameScheduler: Scheduler = {
  frame: (fn) => {
    let done = false
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      cancelAnimationFrame(raf)
      if (timer !== undefined) clearTimeout(timer)
    }
    const run = (): void => {
      if (done) return
      done = true
      stop()
      fn()
    }
    raf = requestAnimationFrame(run)
    timer = setTimeout(run, 50)
    return () => {
      done = true
      stop()
    }
  },
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
