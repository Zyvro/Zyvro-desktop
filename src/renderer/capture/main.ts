// Les fenêtres de capture. Une page, cinq rôles, choisis par le fragment de
// l'adresse : le processus principal ouvre `capture.html#overlay`, `#recorder`…
//
// Sans React : ce sont de petites fenêtres qui vivent quelques secondes, et le
// DOM suffit. Chaque rôle est dans son propre module, chargé seul — la
// sélection n'a pas à embarquer l'encodeur GIF.

import "./capture.css"

const role = location.hash.slice(1)
document.documentElement.dataset.role = role

const roles: Record<string, () => Promise<{ start: () => void | Promise<void> }>> = {
  overlay: () => import("./overlay"),
  border: () => import("./border"),
  pill: () => import("./pill"),
  recorder: () => import("./recorder"),
  result: () => import("./result"),
}

const load = roles[role]
if (load) {
  void load().then((m) => m.start())
}
