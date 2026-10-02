// Traduire ce que claude parle vers ce que nos serveurs parlent.
//
// Claude Code poste sur l'API **Messages** d'Anthropic : `POST /v1/messages`,
// en flux. Nos fournisseurs parlent Chat Completions — LM Studio, Ollama, tout
// ce que le panneau Fournisseurs sait déjà appeler. Entre les deux il manquait
// une traduction, et c'était la seule raison pour laquelle claude ne pouvait
// pas viser nos modèles quand codex et qwen le pouvaient : `aimable: false`
// dans la table des harnais ne disait pas « impossible », il disait « pas
// écrit ».
//
// Ce module est la traduction, et rien d'autre : pas de serveur, pas de
// réseau. Il se teste en appelant des fonctions.
//
// **Relevé sur le binaire, pas supposé.** Le corps que claude-cli/2.1.278
// envoie a été enregistré en le faisant parler à un serveur qui écrit ce qu'il
// reçoit :
//
//   POST /v1/messages?beta=true
//   authorization: Bearer <ANTHROPIC_AUTH_TOKEN>
//   { model, max_tokens: 32000, stream: true,
//     system: [ {type:"text", text, cache_control?} × 3 ],
//     tools:  [ {name, description, input_schema} × 28 ],
//     messages: [ {role:"user"|"assistant"|"system", content: string | Bloc[] } ],
//     thinking: {type:"adaptive", display:"omitted"},
//     context_management: {…}, metadata: {…}, output_config: {…} }
//
// Quatre choses de ce relevé n'étaient pas devinables :
//
// · **`system` est une liste**, pas une chaîne, et elle porte des marqueurs de
//   cache. Chat n'a qu'un message système : on met les textes bout à bout.
// · **`role: "system"` apparaît AU MILIEU des messages** — c'est la bêta
//   `mid-conversation-system`. Le traiter comme un rôle inconnu perdrait les
//   rappels que la CLI glisse en cours de tour.
// · **`content` est tantôt une chaîne, tantôt une liste de blocs.** Les deux
//   arrivent dans le même tour, sur des messages voisins.
// · **`tool_result` voyage dans un message `user`.** Chat veut un message
//   `tool` séparé, placé juste après l'appel — donc l'ordre compte, et un
//   résultat mis après le texte de l'utilisateur fait refuser la requête.

import type { ChatContent, ChatMessage, ChatRequest } from "./responses"

/** Ce qui arrive de claude. Du texte jusqu'à preuve du contraire. */
export type MessagesRequest = Record<string, unknown>

function texteDe(valeur: unknown): string {
  return typeof valeur === "string" ? valeur : ""
}

function objet(valeur: unknown): Record<string, unknown> {
  return valeur && typeof valeur === "object" ? (valeur as Record<string, unknown>) : {}
}

function liste(valeur: unknown): unknown[] {
  return Array.isArray(valeur) ? valeur : []
}

// aplati rend le texte d'un contenu, qu'il soit déjà une chaîne ou une liste de
// blocs. `tool_result` s'en sert aussi : son `content` a exactement les deux
// mêmes formes.
export function aplati(contenu: unknown): string {
  if (typeof contenu === "string") return contenu
  const morceaux: string[] = []
  for (const bloc of liste(contenu)) {
    const b = objet(bloc)
    if (b.type === "text") morceaux.push(texteDe(b.text))
  }
  return morceaux.join("\n")
}

// systemFrom : la liste `system` devient le message système de Chat.
//
// Mis bout à bout plutôt que réduit au premier : les trois blocs relevés ne
// sont pas des variantes, ce sont trois parties — l'en-tête de facturation, le
// prompt de l'agent, et ce que `--append-system-prompt` ajoute. N'en garder
// qu'un ferait travailler le modèle sans les deux autres.
export function systemFrom(body: MessagesRequest): string {
  return typeof body.system === "string" ? body.system : aplati(body.system)
}

// imageFrom : une image d'Anthropic devient une image de Chat.
//
// Anthropic la porte en base64 avec son type MIME à côté ; Chat veut une URL,
// et une URL `data:` en est une. Une image référencée par URL passe telle
// quelle. Tout le reste — un fichier téléversé chez Anthropic, par exemple —
// n'a pas d'équivalent chez un serveur local et est écarté plutôt qu'envoyé
// sous une forme qu'il refuserait.
function imageFrom(bloc: Record<string, unknown>): ChatContent | null {
  const source = objet(bloc.source)
  if (source.type === "base64") {
    const media = texteDe(source.media_type) || "image/png"
    const data = texteDe(source.data)
    if (!data) return null
    return { type: "image_url", image_url: { url: `data:${media};base64,${data}` } }
  }
  const url = texteDe(source.url)
  return url ? { type: "image_url", image_url: { url } } : null
}

// messagesFrom : les blocs d'Anthropic deviennent des messages de Chat.
//
// L'ordre est la partie qui casse si on l'oublie. Chat exige qu'un message
// `tool` suive immédiatement l'assistant qui a demandé l'outil ; claude, lui,
// renvoie le résultat dans le message `user` suivant, mélangé au texte. Donc
// les résultats sortent d'abord, le texte de l'utilisateur ensuite.
export function messagesFrom(body: MessagesRequest): ChatMessage[] {
  const out: ChatMessage[] = []

  const system = systemFrom(body)
  if (system) out.push({ role: "system", content: system })

  for (const message of liste(body.messages)) {
    const m = objet(message)
    const role = texteDe(m.role)
    const contenu = m.content

    // Un rappel système glissé en cours de conversation. Il traverse tel quel.
    if (role === "system") {
      const texte = aplati(contenu)
      if (texte) out.push({ role: "system", content: texte })
      continue
    }

    if (typeof contenu === "string") {
      if (contenu) out.push({ role, content: contenu })
      continue
    }

    const blocs = liste(contenu).map(objet)

    // D'abord ce que les outils ont répondu.
    for (const bloc of blocs) {
      if (bloc.type !== "tool_result") continue
      const texte = aplati(bloc.content)
      out.push({
        role: "tool",
        tool_call_id: texteDe(bloc.tool_use_id),
        // `is_error` n'a pas de champ chez Chat : le dire dans le contenu est
        // la seule façon que le modèle le sache, et il le sait déjà comme ça
        // chez la plupart des serveurs.
        content: bloc.is_error === true ? `Error: ${texte}` : texte,
      })
    }

    if (role === "assistant") {
      const texte = blocs
        .filter((bloc) => bloc.type === "text")
        .map((bloc) => texteDe(bloc.text))
        .join("\n")
      const appels = blocs
        .filter((bloc) => bloc.type === "tool_use")
        .map((bloc) => ({
          id: texteDe(bloc.id),
          type: "function" as const,
          function: { name: texteDe(bloc.name), arguments: JSON.stringify(bloc.input ?? {}) },
        }))
      // Un assistant vide n'existe pas chez Chat : sans texte ni appel il n'y a
      // rien à dire, et un message vide de plus fait refuser certains serveurs.
      if (texte || appels.length > 0) {
        const sortie: ChatMessage = { role: "assistant", content: texte || null }
        if (appels.length > 0) sortie.tool_calls = appels
        out.push(sortie)
      }
      continue
    }

    // Un utilisateur : du texte, et parfois des images.
    const morceaux: ChatContent[] = []
    for (const bloc of blocs) {
      if (bloc.type === "text") {
        const texte = texteDe(bloc.text)
        if (texte) morceaux.push({ type: "text", text: texte })
      } else if (bloc.type === "image") {
        const image = imageFrom(bloc)
        if (image) morceaux.push(image)
      }
    }
    if (morceaux.length === 0) continue
    // Une chaîne quand il n'y a que du texte : c'est la forme que tous les
    // serveurs acceptent, y compris ceux qui ne connaissent pas les listes.
    const queDuTexte = morceaux.every((morceau) => morceau.type === "text")
    out.push({
      role: role || "user",
      content: queDuTexte ? morceaux.map((m) => (m.type === "text" ? m.text : "")).join("\n") : morceaux,
    })
  }

  return out
}

// toolsFrom : les outils, emboîtés d'un côté comme de l'autre mais pas pareil.
//
// Anthropic écrit `{name, description, input_schema}` à plat ; Chat écrit
// `{type:"function", function:{name, description, parameters}}`. C'est le même
// schéma JSON dans les deux cas, sous deux noms.
export function toolsFrom(body: MessagesRequest): NonNullable<ChatRequest["tools"]> {
  const out: NonNullable<ChatRequest["tools"]> = []
  for (const outil of liste(body.tools)) {
    const o = objet(outil)
    const name = texteDe(o.name)
    if (!name) continue
    out.push({
      type: "function",
      function: {
        name,
        description: texteDe(o.description),
        parameters: o.input_schema ?? { type: "object", properties: {} },
      },
    })
  }
  return out
}

// toolChoiceFrom : « comme tu veux », « obligatoirement un », « celui-ci ».
//
// Les trois existent des deux côtés sous d'autres noms. `any` d'Anthropic est
// `required` de Chat, ce qui est la seule traduction non évidente des trois.
export function toolChoiceFrom(valeur: unknown): unknown {
  const choix = objet(valeur)
  if (choix.type === "auto") return "auto"
  if (choix.type === "any") return "required"
  if (choix.type === "tool" && texteDe(choix.name)) {
    return { type: "function", function: { name: texteDe(choix.name) } }
  }
  return undefined
}

export function chatRequestFrom(body: MessagesRequest, model: string): ChatRequest {
  const chat: ChatRequest = {
    model,
    messages: messagesFrom(body),
    stream: true,
    // Sans `include_usage`, un flux Chat ne porte aucun compte et le reçu de
    // jetons du panneau afficherait zéro pour un tour qui a coûté.
    stream_options: { include_usage: true },
  }
  // `max_tokens` traverse : claude demande 32 000, et un serveur local qui n'en
  // peut pas tant le rabote lui-même. Ne rien envoyer laisserait le défaut du
  // serveur, souvent 256, et l'agent serait coupé au milieu d'une phrase.
  const max = typeof body.max_tokens === "number" ? body.max_tokens : 0
  if (max > 0) (chat as Record<string, unknown>).max_tokens = max

  const outils = toolsFrom(body)
  if (outils.length > 0) {
    chat.tools = outils
    const choix = toolChoiceFrom(body.tool_choice)
    if (choix !== undefined) chat.tool_choice = choix
  }
  return chat
}

// ---- le flux de retour ---------------------------------------------------

/** Un événement du flux Messages, tel qu'il partira sur le fil. */
export type MessagesEvent = { type: string; [key: string]: unknown }

type Appel = { id: string; name: string; args: string; index: number }

// arret : ce que Chat appelle la fin, dit comme Anthropic le dit.
//
// `tool_calls` devient `tool_use`, et c'est celui qui compte : claude décide
// par lui s'il doit exécuter un outil ou rendre la main. Un `end_turn` posé à
// la place d'un `tool_use` fait afficher une réponse vide pour un tour où le
// modèle demandait à lire un fichier.
export function arret(finish: unknown): string {
  if (finish === "tool_calls" || finish === "function_call") return "tool_use"
  if (finish === "length") return "max_tokens"
  return "end_turn"
}

/**
 * Translator tient l'état d'un tour et rend les événements d'Anthropic.
 *
 * Un tour Chat est une suite de morceaux ; un tour Messages est une suite de
 * blocs qui s'ouvrent, coulent et se ferment, chacun numéroté. Toute la classe
 * est là pour ça : savoir quel bloc est ouvert et le fermer avant d'en ouvrir
 * un autre. Un bloc laissé ouvert fait attendre claude indéfiniment.
 */
export class Translator {
  private readonly model: string
  private readonly messageId: string
  /** Le numéro du prochain bloc à ouvrir. */
  private index = 0
  /** Le bloc ouvert en ce moment, s'il y en a un. */
  private ouvert: "text" | "tool_use" | null = null
  /** Les appels d'outils arrivent par morceaux, numérotés par le serveur. */
  private readonly appels = new Map<number, Appel>()
  private entree = 0
  private sortie = 0
  private finish: unknown = null

  constructor(model: string, seed = Date.now().toString(36)) {
    this.model = model
    this.messageId = `msg_${seed}`
  }

  /** `message_start`, qui ouvre le tour. */
  created(): MessagesEvent {
    return {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
  }

  private fermer(out: MessagesEvent[]): void {
    if (this.ouvert === null) return
    out.push({ type: "content_block_stop", index: this.index })
    this.ouvert = null
    this.index += 1
  }

  /** push lit un morceau de Chat et rend ce qu'il faut envoyer. */
  push(brut: unknown): MessagesEvent[] {
    const out: MessagesEvent[] = []
    const chunk = objet(brut)

    // Le compte arrive sur le dernier morceau, qui souvent n'a plus de choix.
    const usage = objet(chunk.usage)
    if (typeof usage.prompt_tokens === "number") this.entree = usage.prompt_tokens
    if (typeof usage.completion_tokens === "number") this.sortie = usage.completion_tokens

    const choix = objet(liste(chunk.choices)[0])
    if (choix.finish_reason !== undefined && choix.finish_reason !== null) this.finish = choix.finish_reason
    const delta = objet(choix.delta)

    const texte = texteDe(delta.content)
    if (texte) {
      if (this.ouvert !== "text") {
        this.fermer(out)
        out.push({ type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } })
        this.ouvert = "text"
      }
      out.push({ type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: texte } })
    }

    for (const morceau of liste(delta.tool_calls)) {
      const appel = objet(morceau)
      const numero = typeof appel.index === "number" ? appel.index : 0
      const fonction = objet(appel.function)
      let connu = this.appels.get(numero)

      if (!connu) {
        // Un appel commence : le bloc de texte en cours se ferme d'abord.
        this.fermer(out)
        connu = {
          id: texteDe(appel.id) || `toolu_${this.messageId}_${numero}`,
          name: texteDe(fonction.name),
          args: "",
          index: this.index,
        }
        this.appels.set(numero, connu)
        out.push({
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: connu.id, name: connu.name, input: {} },
        })
        this.ouvert = "tool_use"
      }

      // Certains serveurs n'envoient le nom qu'au deuxième morceau. Le bloc est
      // déjà annoncé à ce moment-là, donc on le complète ici — c'est la seule
      // valeur qu'on corrige après coup, et claude lit le nom au `stop`.
      if (!connu.name && texteDe(fonction.name)) connu.name = texteDe(fonction.name)

      const args = texteDe(fonction.arguments)
      if (args) {
        connu.args += args
        out.push({
          type: "content_block_delta",
          index: connu.index,
          delta: { type: "input_json_delta", partial_json: args },
        })
      }
    }

    return out
  }

  /** end ferme ce qui est ouvert et clôt le tour. */
  end(): MessagesEvent[] {
    const out: MessagesEvent[] = []
    this.fermer(out)
    out.push({
      type: "message_delta",
      delta: { stop_reason: arret(this.finish), stop_sequence: null },
      usage: { input_tokens: this.entree, output_tokens: this.sortie },
    })
    out.push({ type: "message_stop" })
    return out
  }

  /** failed dit une panne dans la forme qu'un client d'Anthropic sait lire. */
  failed(message: string): MessagesEvent {
    return { type: "error", error: { type: "api_error", message } }
  }
}
