// Le cadre autour d'une zone qu'on enregistre. La fenêtre ignore la souris et
// n'apparaît pas dans les captures ; elle ne fait que dire où regarde
// l'enregistrement.

import { el } from "./dom"

export function start(): void {
  document.body.append(el("div", { className: "frame" }))
}
