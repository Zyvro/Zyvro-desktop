import type { CaptureBridge } from "../../preload/capture"

// Le pont des fenêtres de capture, posé par src/preload/capture.ts.
declare global {
  interface Window {
    zyvroCapture: CaptureBridge
  }
}

export {}
