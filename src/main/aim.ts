// Viser un harnais sur un serveur que ce projet a déjà allumé.
//
// Le panneau propose des modèles écrits « fournisseur/modèle » —
// « lmstudio/qwen3-coder-next » — parce qu'un seul choix décide des deux :
// prendre un modèle dans la liste d'un serveur, c'est prendre ce serveur.
//
// Reste à retrouver l'adresse, et elle ne se recopie pas ici. Le moteur la
// tient, la personne l'a réglée dans le panneau des fournisseurs, et une
// deuxième idée de « où est LM Studio » serait celle qui a tort le jour où le
// port change. On la lui demande.

import { type Aim, splitAimed } from "../shared/harness"

type ProviderRow = { id?: unknown; endpoint?: unknown; endpoint_url?: unknown }

// aimFor rend la visée d'un modèle, ou null — et null n'est pas une panne :
// c'est ce que rendent un modèle sans barre oblique (le harnais garde son
// propre compte), un fournisseur que ce projet n'a pas allumé, et un moteur
// qui ne tourne pas encore. Dans les trois cas le tour part quand même, sur le
// compte du harnais, ce qui est la chose la moins surprenante à faire.
export async function aimFor(
  model: string | null,
  daemon: { origin?: string; token?: string } | null | undefined
): Promise<Aim | null> {
  const split = splitAimed(model)
  if (!split || !daemon?.origin || !daemon.token) return null

  let rows: ProviderRow[]
  try {
    const response = await fetch(`${daemon.origin}/api/providers`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { providers?: unknown }
    if (!Array.isArray(body.providers)) return null
    rows = body.providers as ProviderRow[]
  } catch {
    return null
  }

  const row = rows.find((p) => p.id === split.provider && p.endpoint === true)
  if (!row) return null

  // L'adresse ET la clef, demandées par leur nom.
  //
  // `/api/providers` ne rend pas la clef, et c'est délibéré : ce catalogue est
  // affiché, et une clef qu'on affiche est une clef qu'on finit par recopier
  // ailleurs. La route dédiée existe pour ce cas-ci — un agent lancé sur cette
  // machine qui doit vraiment parler au serveur. Sans elle, un point d'accès
  // distant à clef se faisait refuser l'accès et rien ne disait pourquoi.
  //
  // Elle s'arrête ici : le processus principal la garde, la passe à l'agent par
  // son environnement, et la fenêtre ne la voit jamais.
  try {
    const response = await fetch(`${daemon.origin}/api/providers/${split.provider}/endpoint`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as { url?: unknown; key?: unknown }
    const url = typeof body.url === "string" ? body.url.trim() : ""
    if (!url) return null
    const key = typeof body.key === "string" ? body.key.trim() : ""
    return { provider: split.provider, url, key, model: split.model }
  } catch {
    return null
  }
}

// aimableModels : ce que les serveurs de ce projet disent savoir faire tourner.
//
// C'est la moitié qui manquait. Zyvro savait déjà parler à Ollama, à LM Studio
// et à un point d'accès quelconque, et le panneau de l'agent ne savait lancer
// que deux CLI sur l'abonnement de quelqu'un. Les deux moitiés existaient et ne
// se touchaient pas ; un harnais visable est ce qui les relie.
//
// Chaque serveur est interrogé sur ce qu'il a, parce que ce qui est installé
// regarde la personne et change dès qu'elle tire un modèle de plus. Un serveur
// éteint ne fait pas échouer la liste : il n'y figure simplement pas, ce qui
// est exactement ce que « il ne tourne pas » veut dire ici.
export async function aimableModels(
  daemon: { origin?: string; token?: string } | null | undefined
): Promise<string[]> {
  if (!daemon?.origin || !daemon.token) return []
  const auth = { Authorization: `Bearer ${daemon.token}` }

  let rows: ProviderRow[]
  try {
    const response = await fetch(`${daemon.origin}/api/providers`, { headers: auth })
    if (!response.ok) return []
    const body = (await response.json()) as { providers?: unknown }
    if (!Array.isArray(body.providers)) return []
    rows = body.providers as ProviderRow[]
  } catch {
    return []
  }

  const configured = rows.filter(
    (p) => p.endpoint === true && typeof p.id === "string" && String(p.endpoint_url ?? "").trim() !== ""
  )

  // En parallèle : trois serveurs interrogés l'un après l'autre, dont un qui ne
  // répond pas, c'est le délai d'attente de celui-là ajouté à l'attente de tout
  // le monde. Le panneau, lui, attend cette liste pour s'ouvrir.
  const lists = await Promise.all(
    configured.map(async (p) => {
      const id = String(p.id)
      try {
        const response = await fetch(`${daemon.origin}/api/providers/${id}/models`, { headers: auth })
        if (!response.ok) return []
        const body = (await response.json()) as { models?: unknown }
        if (!Array.isArray(body.models)) return []
        return body.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => `${id}/${m}`)
      } catch {
        return []
      }
    })
  )
  return lists.flat()
}
