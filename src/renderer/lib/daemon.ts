// The shared web components reach the backend through Zyvro-frontend/src/lib/api.ts,
// which reads its origin once at module load into a const. In the desktop app the
// origin is a loopback port we only learn when the daemon starts, and every request
// must also carry the daemon's bearer token.
//
// Rather than fork api.ts, we rewrite the requests as they leave. The build
// replaces its origin with the placeholder below; this interceptor swaps in the
// real origin and attaches the token. The shared code stays untouched, which is
// the point: one graph editor, two shells.

import { setMediaOriginResolver } from "@/lib/api"

const PLACEHOLDER = "http://127.0.0.1:0"

let origin = ""
let token = ""

export function attachDaemon(nextOrigin: string, nextToken: string): void {
  origin = nextOrigin
  token = nextToken
}

export function detachDaemon(): void {
  origin = ""
  token = ""
}

export function daemonOrigin(): string {
  return origin
}

// resolveDaemonUrl maps a placeholder URL onto the live daemon. It returns null
// for anything else so the interceptor leaves unrelated requests alone.
function resolveDaemonUrl(url: string): string | null {
  if (!url.startsWith(PLACEHOLDER)) return null
  if (!origin) return null
  return origin + url.slice(PLACEHOLDER.length)
}

export class DaemonNotReady extends Error {
  constructor() {
    super("The local Zyvro engine is not running. Open a project first.")
  }
}

export function installDaemonFetch(): void {
  // The same swap for images. An <img> is loaded by the browser, not by fetch,
  // so the interceptor below never sees it — which is why the daemon serves
  // /content without a token, and why the shared mediaUrl has to be told where
  // the engine is instead of being duplicated here.
  setMediaOriginResolver(resolveMediaUrl)

  const original = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

    const target = resolveDaemonUrl(requestUrl)
    if (target === null) {
      // A request aimed at the placeholder with no daemon running would
      // otherwise fail as a confusing connection error on port 0.
      if (requestUrl.startsWith(PLACEHOLDER)) throw new DaemonNotReady()
      return original(input, init)
    }

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    headers.set("Authorization", `Bearer ${token}`)

    if (input instanceof Request) {
      return original(new Request(target, input), { ...init, headers })
    }
    return original(target, { ...init, headers })
  }
}

// resolveMediaUrl maps a placeholder media URL onto the live daemon. The origin
// is read at call time rather than captured, because a project can be opened,
// closed and reopened on a different port within one run of the app.
function resolveMediaUrl(url: string): string {
  if (!url.startsWith(PLACEHOLDER) || !origin) return url
  return origin + url.slice(PLACEHOLDER.length)
}
