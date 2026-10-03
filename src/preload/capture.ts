import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { plainMessage } from "../shared/ipcerror"
import type { Rect } from "../shared/capture"

// Le pont des fenêtres de capture : la sélection, l'enregistreur, la pastille
// d'arrêt et la fenêtre de résultat.
//
// À part de celui de la fenêtre principale, et bien plus étroit : ces fenêtres
// n'ont rien à faire d'un projet, d'un shell ou d'un agent. Des opérations
// nommées seulement ; le processus principal vérifie en plus que chacune vient
// de la fenêtre qui a le droit de la demander.

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).then(
    (value) => value as T,
    (err: unknown) => {
      throw new Error(plainMessage(err), { cause: err })
    }
  )
}

function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export type OverlayInfo = { mode: "image" | "video"; width: number; height: number }
export type RecorderConfig = {
  /** La zone, en points, dans l'écran enregistré. */
  rect: Rect
  /** L'écran, en points. */
  screen: { width: number; height: number }
  maxMs: number
}
export type Recorded = {
  webm: Uint8Array
  gif: Uint8Array | null
  gifTooLarge: boolean
  width: number
  height: number
  ms: number
}
export type CaptureView =
  | { kind: "image"; preview: string; width: number; height: number; kept: string | null; signedIn: boolean }
  | {
      kind: "video"
      webm: Uint8Array
      width: number
      height: number
      ms: number
      hasGif: boolean
      gifTooLarge: boolean
      kept: string | null
      signedIn: boolean
    }
export type PublishedView = { url: string; gifUrl: string | null; expiresAt: string }

const api = {
  platform: process.platform,
  overlay: {
    info: (): Promise<OverlayInfo> => invoke("capture:overlay-info"),
    /** La zone choisie, en points dans cet écran, ou null pour annuler. */
    select: (rect: Rect | null): Promise<void> => invoke("capture:select", rect),
  },
  recorder: {
    config: (): Promise<RecorderConfig> => invoke("capture:recorder-config"),
    started: (): Promise<void> => invoke("capture:recorder-started"),
    done: (recorded: Recorded): Promise<void> => invoke("capture:recorded", recorded),
    failed: (message: string): Promise<void> => invoke("capture:record-failed", message),
    onStop: (cb: () => void) => on("capture:stop", cb),
  },
  pill: {
    stop: (): Promise<void> => invoke("capture:stop-request"),
    onTick: (cb: (tick: { elapsed: number; max: number }) => void) => on("capture:tick", cb),
  },
  result: {
    current: (): Promise<CaptureView | null> => invoke("capture:current"),
    copyImage: (): Promise<void> => invoke("capture:copy-image"),
    save: (format: "png" | "webm" | "gif"): Promise<string | null> => invoke("capture:save", format),
    publish: (): Promise<PublishedView> => invoke("capture:publish"),
    copyText: (text: string): Promise<void> => invoke("capture:copy-text", text),
    reveal: (): Promise<void> => invoke("capture:reveal"),
    openStudio: (): Promise<void> => invoke("capture:open-studio"),
    close: (): Promise<void> => invoke("capture:close"),
  },
}

export type CaptureBridge = typeof api

contextBridge.exposeInMainWorld("zyvroCapture", api)
