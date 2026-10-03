// La sélection d'une zone : un voile sur l'écran, et le rectangle qu'on y
// trace. Une fenêtre par écran ; la zone reste dans celui où elle a commencé.

import { selectionRect, type Rect } from "../../shared/capture"
import { el } from "./dom"

export async function start(): Promise<void> {
  const bridge = window.zyvroCapture
  const info = await bridge.overlay.info()

  const veil = el("div", { className: "veil" })
  const box = el("div", { className: "box" })
  const size = el("div", { className: "size" })
  const hint = el("div", {
    className: "hint",
    textContent:
      info.mode === "video"
        ? "Drag to choose the area to record — up to 1 minute. Esc to cancel."
        : "Drag to capture an area. Esc to cancel.",
  })
  box.hidden = true
  size.hidden = true
  document.body.append(veil, box, size, hint)

  let from: { x: number; y: number } | null = null
  let sent = false
  const finish = (rect: Rect | null) => {
    if (sent) return
    sent = true
    void bridge.overlay.select(rect)
  }

  const draw = (to: { x: number; y: number }) => {
    if (!from) return
    const x = Math.min(from.x, to.x)
    const y = Math.min(from.y, to.y)
    const w = Math.abs(to.x - from.x)
    const h = Math.abs(to.y - from.y)
    Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
    box.hidden = false
    veil.hidden = true
    size.hidden = false
    size.textContent = `${Math.round(w)} × ${Math.round(h)}`
    // Sous la zone, ou dedans quand elle touche le bas de l'écran.
    const below = y + h + 26 < window.innerHeight
    Object.assign(size.style, { left: `${x}px`, top: `${below ? y + h + 6 : y + 6}px` })
  }

  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return
    from = { x: event.clientX, y: event.clientY }
    hint.hidden = true
  })
  window.addEventListener("mousemove", (event) => draw({ x: event.clientX, y: event.clientY }))
  window.addEventListener("mouseup", (event) => {
    if (!from || event.button !== 0) return
    const rect = selectionRect(from, { x: event.clientX, y: event.clientY }, {
      width: window.innerWidth,
      height: window.innerHeight,
    })
    from = null
    if (rect) finish(rect)
    else {
      // Un clic n'est pas une zone : on recommence.
      box.hidden = true
      size.hidden = true
      veil.hidden = false
      hint.hidden = false
    }
  })
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") finish(null)
  })
  window.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    finish(null)
  })
}
