import type { ZyvroBridge } from "../preload"

// The bridge is installed by the preload script, so from the renderer's point
// of view it simply exists on window. This lives here, and not next to the
// preload source, because TypeScript treats an index.d.ts sitting beside an
// index.ts as that file's generated output and skips it.
declare global {
  interface Window {
    zyvro: ZyvroBridge
  }
}

export {}
