// Poser une vue native dans une capture.
//
// `capturePage` rend le HTML d'une fenêtre. Les outils de développement n'en
// sont pas : ce sont une vue native posée par-dessus la page — le seul moyen
// qu'Electron accepte de brancher son inspecteur. Une capture du panneau qui
// les contient rendait donc un trou : le fond de l'application, là où on voyait
// Elements, Console et Network. Rien dans l'image ne le disait ; elle avait
// l'air normale, simplement vide.
//
// D'où cette composition : la fenêtre d'un côté, chaque vue native de l'autre,
// recollées à l'emplacement où elles sont dessinées.
//
// Ce fichier ne fait que l'arithmétique — deux images à plat, un décalage, et
// le découpage aux bords. Il ne connaît pas Electron, ce qui permet de le
// vérifier sans ouvrir une fenêtre.

/** Une image à plat : des pixels BGRA, en rangées de `width`. */
export type Plane = { data: Buffer; width: number; height: number }

// pixelRatio : combien de pixels pour un point.
//
// Une capture sur un écran Retina rend deux fois plus de pixels que de points,
// et les deux images doivent être dans la même unité avant de se superposer.
// Un rapport qui n'est pas un carré entier veut dire qu'on n'a pas compris le
// tampon qu'on tient : mieux vaut ne rien composer que décaler chaque rangée
// d'un pixel, ce qui rendrait une image oblique que personne ne saurait
// expliquer.
export function pixelRatio(bytes: number, width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0
  const squared = bytes / (width * height * 4)
  const ratio = Math.round(Math.sqrt(squared))
  return ratio > 0 && ratio * ratio === squared ? ratio : 0
}

// viewScale : combien de pixels d'image pour un point d'écran.
//
// C'est le piège de toute cette composition, et il ne se voit pas : la capture
// d'une zone de 759 points sur un écran Retina rend une image de 1518 pixels,
// mais les vues natives, elles, se placent en points. Poser l'une dans l'autre
// sans convertir met les outils au quart de leur place, en haut à gauche, et
// l'image reste plausible — on croit à un bogue d'affichage.
//
// On le déduit de ce qu'on tient — la largeur en pixels de l'image, celle en
// points de ce qu'on a demandé — plutôt que de le supposer : l'application peut
// être sur l'écran externe pendant que la machine a un écran Retina.
export function viewScale(pixels: number, points: number): number {
  if (points <= 0 || pixels <= 0) return 0
  return pixels / points
}

// blit copie `patch` dans `base` à (x, y) et rend le nombre de rangées posées.
//
// Le découpage n'est pas une précaution théorique : les outils occupent le bas
// du panneau du navigateur, et on photographie le panneau — la vue dépasse donc
// par le bas dès que la fenêtre est plus haute que la zone demandée, et une
// copie qui ne couperait pas écrirait au-delà du tampon ou replierait les
// rangées.
export function blit(base: Plane, patch: Plane, x: number, y: number): number {
  const left = Math.max(0, Math.round(x))
  const top = Math.max(0, Math.round(y))
  const right = Math.min(base.width, Math.round(x) + patch.width)
  const bottom = Math.min(base.height, Math.round(y) + patch.height)
  if (right <= left || bottom <= top) return 0

  const wide = (right - left) * 4
  for (let row = top; row < bottom; row++) {
    const from = ((row - Math.round(y)) * patch.width + (left - Math.round(x))) * 4
    const to = (row * base.width + left) * 4
    patch.data.copy(base.data, to, from, from + wide)
  }
  return bottom - top
}
