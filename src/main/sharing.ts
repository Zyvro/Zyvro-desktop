import { authorized, webOrigin } from "./account"

// Sharing a workflow with somebody, and reading back the ones you already have
// on your account.
//
// Both are the same idea from two ends: a workflow in a project is a file, a
// workflow on the account is a row, and this is the crossing between them.
//
// Nothing new was needed on the server. A hosted workflow already carries a
// visibility, and `unlisted` is exactly what "private, reachable only by the
// link" means: `GET /api/workflows/{id}/shared` answers for it to anyone
// holding the link and refuses a `private` one to everybody but its owner, and
// the page it backs already offers to copy it into the visitor's space. So
// sharing is a create with one field set, and the link is the page that already
// exists.

export type SharedWorkflow = {
  id: string
  name: string
  /** Where the person sends their friend. */
  url: string
}

// share uploads a copy and answers with the link.
//
// A copy, deliberately: what is shared is a snapshot, not a live view of the
// file on this machine. Editing the graph tomorrow does not rewrite what
// somebody was sent today, which is what "I sent you this" should mean.
export async function share(payload: {
  name: string
  description: string
  graph: unknown
}): Promise<SharedWorkflow> {
  const created = (await authorized("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      description: payload.description,
      graph_json: payload.graph,
      // Unlisted, never public: sharing with a friend is not publishing to a
      // catalogue, and the two are one word apart in this API.
      visibility: "unlisted",
    }),
  })) as { id?: string; name?: string }

  if (!created?.id) throw new Error("The server accepted the workflow but did not say where it went.")
  return { id: created.id, name: created.name ?? payload.name, url: `${webOrigin()}/w/${created.id}` }
}

// HostedWorkflow is one row of the account's own workflows, as the API sends
// it. The field names are the server's; they are not restated.
export type HostedWorkflow = {
  id: string
  name: string
  description: string
  graph_json: string
  visibility: string
  updated_at: string
}

// mine lists what this account holds, newest first — which is the order the
// server already answers in, and the order somebody looking for "the one I made
// yesterday" wants.
export async function mine(): Promise<HostedWorkflow[]> {
  const listed = (await authorized("/api/workflows")) as unknown
  return Array.isArray(listed) ? (listed as HostedWorkflow[]) : []
}
