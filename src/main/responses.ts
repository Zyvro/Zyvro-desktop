// La passerelle qui permet de viser codex ailleurs que sur son abonnement.
//
// codex ne poste que sur l'API Responses d'OpenAI. Nos fournisseurs parlent
// Chat Completions. Ce serveur se met entre les deux : il écoute en Responses
// sur la boucle locale, appelle en Chat, et retraduit le flux. La traduction
// elle-même est dans `shared/responses.ts` et ne connaît pas le réseau ; ici il
// n'y a que la plomberie.
//
// Trois décisions, et chacune a une raison qu'on paie si on l'oublie :
//
// · **Un seul serveur par fenêtre, pas un par tour.** Ouvrir une socket à
//   chaque message pour la fermer trois secondes plus tard, c'est un port neuf
//   à chaque fois et une course garantie le jour où deux tours partent
//   ensemble. Le routage se fait sur le nom du modèle.
//
// · **Le modèle visé EST la route.** codex renvoie dans son corps le `model`
//   qu'on lui a passé. On lui donne « lmstudio/qwen3-coder-next » — la chaîne
//   que le panneau écrit déjà — et la passerelle sait par elle à quel serveur
//   parler et sous quel nom. Deux sessions visant deux fournisseurs différents
//   ne peuvent donc pas se marcher dessus.
//
// · **Un jeton, et l'adresse en 127.0.0.1.** Ce serveur porte les clefs des
//   fournisseurs : tout ce qui tourne sur la machine pourrait s'en servir
//   comme d'un relais anonyme. codex sait lire une clef dans une variable
//   d'environnement, donc elle n'apparaît pas non plus dans la table des
//   processus.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import type { Aim } from "../shared/harness"
import { chatRequestFrom, sseLine, Translator, type ResponsesRequest } from "../shared/responses"

export type GatewayHandle = {
  /** Ce qu'on écrit dans `base_url`. codex y ajoute `/responses`. */
  baseUrl: string
  token: string
  /** Enregistre une visée sous le nom de modèle que codex renverra. */
  aim: (key: string, aim: Aim) => void
  close: () => void
}

export async function startGateway(): Promise<GatewayHandle> {
  const token = randomBytes(24).toString("hex")
  const routes = new Map<string, Aim>()

  const server: Server = createServer((req, res) => {
    void handle(req, res, token, routes)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    aim: (key, aim) => routes.set(key, aim),
    close: () => server.close(),
  }
}

function refuser(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message, type: "zyvro_gateway" } }))
}

async function corps(req: IncomingMessage): Promise<string> {
  const morceaux: Buffer[] = []
  for await (const c of req) morceaux.push(c as Buffer)
  return Buffer.concat(morceaux).toString("utf8")
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  routes: Map<string, Aim>
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${token}`) {
    refuser(res, 401, "Unauthorized.")
    return
  }

  const chemin = (req.url ?? "").split("?")[0]

  // codex interroge cette route au démarrage, et ce n'est PAS la liste de
  // modèles d'OpenAI : c'est son catalogue à lui. Relevé avec
  // `codex debug models` — `{"models":[{slug, display_name, context_window,
  // base_instructions, tool_mode, …}]}`, une quarantaine de champs dont
  // plusieurs changent son comportement.
  //
  // On rend donc un catalogue **vide**, pas un catalogue inventé. Fabriquer une
  // entrée demanderait d'annoncer un `context_window` pour un modèle local dont
  // on ne sait rien : trop grand, codex envoie plus que le serveur ne peut
  // prendre — c'est exactement la panne qu'on a vue — et `base_instructions`
  // réécrirait le prompt de l'agent.
  //
  // Vide et bien formé plutôt qu'absent ou mal formé : la première version
  // rendait la forme d'OpenAI (`{object:"list", data:[…]}`), que codex ne sait
  // pas décoder, et il écrivait deux fois par tour « failed to decode models
  // response: missing field `models` » dans le panneau. Avec un catalogue vide
  // il se rabat en silence sur ses valeurs par défaut, en le disant une fois.
  if (chemin === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ models: [] }))
    return
  }

  if (chemin !== "/v1/responses") {
    refuser(res, 404, `No route for ${chemin}.`)
    return
  }

  let body: ResponsesRequest
  try {
    body = JSON.parse(await corps(req)) as ResponsesRequest
  } catch {
    refuser(res, 400, "The body is not JSON.")
    return
  }

  const demande = typeof body.model === "string" ? body.model : ""
  const aim = routes.get(demande)
  if (!aim) {
    // Nommer ce qu'on connaît : sans ça, « unknown model » pour une faute de
    // frappe dans un réglage se cherche à l'aveugle.
    refuser(res, 404, `This gateway serves ${[...routes.keys()].join(", ") || "no model yet"}, not "${demande}".`)
    return
  }

  const chat = chatRequestFrom(body, aim.model)
  let amont: Response
  try {
    amont = await fetch(`${aim.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aim.key.trim() || "local"}` },
      body: JSON.stringify(chat),
    })
  } catch (err) {
    // L'adresse du fournisseur est nommée : « fetch failed » tout seul ne dit
    // pas quel serveur est éteint quand on en a trois.
    refuser(res, 502, `Could not reach ${aim.provider} at ${aim.url}: ${(err as Error).message}`)
    return
  }

  if (!amont.ok || !amont.body) {
    const detail = await amont.text().catch(() => "")
    refuser(res, amont.status === 200 ? 502 : amont.status, detail || `${aim.provider} answered ${amont.status}.`)
    return
  }

  const traducteur = new Translator(demande)
  let commence = false
  // On n'écrit les en-têtes qu'au premier événement utile : tant qu'on n'a
  // rien envoyé, une erreur peut encore partir en code HTTP, ce que codex
  // affiche. Après, elle ne peut plus être qu'un `response.failed`.
  const ouvrir = (): void => {
    if (commence) return
    commence = true
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    res.write(sseLine(traducteur.created()))
  }

  const lecteur = amont.body.getReader()
  const decodeur = new TextDecoder()
  let reste = ""
  let echoue = false

  for (;;) {
    const { done, value } = await lecteur.read()
    if (done) break
    reste += decodeur.decode(value, { stream: true })
    const lignes = reste.split("\n")
    reste = lignes.pop() ?? ""
    for (const ligne of lignes) {
      const propre = ligne.trim()
      if (!propre.startsWith("data:")) continue
      const charge = propre.slice(5).trim()
      if (charge === "" || charge === "[DONE]") continue
      let brut: unknown
      try {
        brut = JSON.parse(charge)
      } catch {
        continue
      }
      const evenements = traducteur.push(brut)
      for (const evenement of evenements) {
        if (evenement.type === "response.failed") {
          // Avant le premier octet, une erreur vaut mieux en HTTP : codex
          // l'affiche mot pour mot au lieu d'un tour vide.
          if (!commence) {
            const erreur = evenement.response as Record<string, unknown> | undefined
            const dedans = (erreur?.error ?? {}) as Record<string, unknown>
            refuser(res, 502, typeof dedans.message === "string" ? dedans.message : "The provider refused.")
          } else {
            res.write(sseLine(evenement))
            res.end()
          }
          echoue = true
          break
        }
        ouvrir()
        res.write(sseLine(evenement))
      }
      if (echoue) break
    }
    if (echoue) break
  }

  if (echoue) return

  ouvrir()
  for (const evenement of traducteur.end()) res.write(sseLine(evenement))
  res.end()
}
