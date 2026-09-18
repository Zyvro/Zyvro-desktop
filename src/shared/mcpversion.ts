// Les versions du protocole MCP que les serveurs de Zyvro savent parler.
//
// Cette liste a un jumeau, en Go, dans `Zyvro-engine/mcp/protocol.go`. Deux
// langages, deux serveurs — le démon du projet et celui de l'application — et
// une seule vérité à tenir : un client qui parle à l'un et à l'autre doit
// obtenir la même réponse.
//
// Ce qui arrive quand elles divergent a été payé une fois. Le serveur de
// l'application répondait `2024-11-05` en dur, quelle que soit la demande. Le
// client de claude s'en accommode ; celui de Qwen Code, non : il demandait
// `2025-06-18`, s'entendait répondre une version de deux ans plus vieille, et
// se déconnectait. Pas d'erreur, pas de trace — juste « MCP server(s) failed to
// start: zyvro-app. Continuing with built-in tools », et un agent qui n'avait
// ni la capture d'écran, ni le navigateur, ni l'outil par lequel il demande une
// permission. Le tour se déroulait quand même.
//
// `check-mcp-version.mjs` compare cette liste à celle du moteur, fichier contre
// fichier.

/** Les versions implémentées, la plus récente d'abord. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const

// negotiateProtocol rend la version du client quand ce serveur la parle, et la
// plus récente sinon — ce qui laisse le client décider de continuer plutôt que
// de le refuser d'emblée. C'est mot pour mot ce que fait `Negotiate` en Go.
export function negotiateProtocol(asked: unknown): string {
  if (typeof asked === "string") {
    for (const version of MCP_PROTOCOL_VERSIONS) {
      if (asked === version) return version
    }
  }
  return MCP_PROTOCOL_VERSIONS[0]
}

// Le code JSON-RPC d'une méthode qu'on ne sert pas.
//
// Nommé plutôt qu'écrit en chiffres à l'appel, et surtout : c'est une erreur
// JSON-RPC, dans une réponse 200, et pas une erreur de transport. Un client qui
// reçoit un 404 en conclut qu'il n'y a pas de serveur ; un client qui reçoit
// `-32601` en conclut que cette méthode-là n'existe pas, et continue.
export const JSONRPC_METHOD_NOT_FOUND = -32601
