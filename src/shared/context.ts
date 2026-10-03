// Combien de la fenêtre le contexte occupe-t-il ?
//
// Le pourcentage sert à décider s'il faut compacter AVANT une longue tâche —
// pas à inventer une précision que le CLI n'a pas donnée. La taille occupée
// vient des reçus (Spent.context) ; la taille de la fenêtre vient d'ici, et
// seulement pour les formes qu'on sait lire.
//
// Ce qui n'est PAS ici : une liste de fenêtres à jour pour chaque modèle du
// monde. Elle changerait sans nous, et une fenêtre fausse donne un pourcentage
// faux — pire qu'un pourcentage absent. Ce qui est ici est ce que les binaires
// et les noms de modèles de ce projet disent réellement.

/**
 * La fenêtre de contexte d'un modèle, en jetons. Null quand on ne la connaît
 * pas — le bouton montre alors la taille, pas un pourcentage inventé.
 *
 * Indices lus, pas supposés :
 * · `claude-opus-5[1m]` — le `[1m]` est le bêta long-contexte d'Anthropic,
 *   un million de jetons. Relevé sur les noms que la CLI elle-même imprime.
 * · Les autres claude (opus/sonnet/haiku sans suffixe) : 200 000, la
 *   fenêtre standard de l'API Messages.
 * · `mimo models` imprime « window 1M » / « window 1.05M » à côté de chaque
 *   nom — c'est de là que vient 1 000 000 pour la famille mimo/xiaomi.
 * · Un nom qu'on ne reconnaît pas rend null, et le bouton ne ment pas.
 */
export function contextWindow(model: string | null | undefined): number | null {
  if (!model) return null
  const m = model.toLowerCase()
  // [1m] est le marqueur de la fenêtre longue — parfois collé, parfois entre
  // crochets, parfois après un tiret selon la source.
  if (/\[1m\]/.test(m) || m.endsWith("-1m") || m.endsWith("[1m")) return 1_000_000
  // MiMo Code annonce ses fenêtres sur `mimo models` : 1M pour mimo-auto,
  // 1.05M pour les xiaomi/mimo-v2.6. Le plus petit des deux est le plancher
  // honnête quand on ne sait pas lequel tourne.
  if (m.includes("mimo") || m.includes("xiaomi")) return 1_000_000
  // La famille Claude standard. Le nom porte « claude » ; les modèles visés
  // chez un fournisseur local s'écrivent « fournisseur/modèle » et n'y
  // entrent pas.
  if (m.startsWith("claude") || m.includes("/claude") || m.includes("claude-")) return 200_000
  return null
}

/**
 * La fenêtre à utiliser pour un fil : le modèle épinglé ET celui qui a
 * réellement tourné, le plus grand des deux.
 *
 * Préférer `ranWith` à `model` : un modèle épinglé « claude-opus-5 » (200k)
 * peut tourner en `[1m]` (1M) — c'est `ranWith` qui le dit, et c'est lui qui
 * décide du pourcentage. Prendre le max des deux couvre le cas inverse aussi.
 */
export function windowForThread(model: string | null | undefined, ranWith: string | null | undefined): number | null {
  const a = contextWindow(model)
  const b = contextWindow(ranWith)
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

/**
 * Le pourcentage de fenêtre occupé, arrondi. Null quand l'une des deux mesures
 * manque : un pourcentage sans fenêtre est un chiffre qui a l'air d'une mesure.
 *
 * Pas borné à 100 : au-delà de la fenêtre, le dire vaut mieux que masquer le
 * dépassement sous un 100% qui a l'air d'un plafond.
 */
export function contextPercent(used: number | null | undefined, model: string | null | undefined): number | null {
  return contextPercentIn(used, contextWindow(model))
}

export function contextPercentIn(used: number | null | undefined, fenetre: number | null | undefined): number | null {
  if (used == null || used <= 0) return null
  if (!fenetre) return null
  return Math.round((used / fenetre) * 100)
}

/**
 * La couleur du pourcentage : vert tant qu'il reste de la place, orange quand
 * une longue tâche risque de tomber sur une compaction automatique, rouge
 * quand elle tombera dessus.
 */
export function contextTone(percent: number): "calm" | "warm" | "hot" {
  if (percent >= 75) return "hot"
  if (percent >= 50) return "warm"
  return "calm"
}
