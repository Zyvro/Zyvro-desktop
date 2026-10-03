// La pastille d'un enregistrement : le temps écoulé, la limite, et Stop.

import { formatElapsed, MAX_RECORDING_MS } from "../../shared/capture"
import { el } from "./dom"

export function start(): void {
  const bridge = window.zyvroCapture
  const time = el("span", { className: "time", textContent: `0:00 / ${formatElapsed(MAX_RECORDING_MS)}` })
  const stop = el("button", { className: "stop", textContent: "Stop" })
  stop.addEventListener("click", () => {
    stop.disabled = true
    stop.textContent = "Stopping…"
    void bridge.pill.stop()
  })
  document.body.append(el("div", { className: "pill" }, el("span", { className: "dot" }), time, stop))
  bridge.pill.onTick(({ elapsed, max }) => {
    time.textContent = `${formatElapsed(elapsed)} / ${formatElapsed(max)}`
  })
}
