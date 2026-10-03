// L'enregistreur : une fenêtre cachée qui filme un écran, n'en garde que la
// zone choisie, et en fait un WebM et un GIF en même temps.
//
// L'écran arrive entier (getDisplayMedia, que le processus principal a limité
// à l'écran choisi). Chaque image est recadrée dans une toile, et c'est la
// toile qu'on enregistre : MediaRecorder ne sait pas recadrer. Le GIF est tiré
// de la même toile, dix fois par seconde, et construit au fil de l'eau — à la
// fin d'une minute, il n'y a qu'à le refermer.

import {
  GIF_FPS,
  GIF_MAX_BYTES,
  VIDEO_BITS_PER_SECOND,
  VIDEO_MAX_SIDE,
  fitWithin,
  gifSize,
  pixelRect,
} from "../../shared/capture"
import { GifClip } from "../../shared/gifclip"

export async function start(): Promise<void> {
  const bridge = window.zyvroCapture
  try {
    await record(bridge)
  } catch (err) {
    await bridge.recorder.failed(err instanceof Error ? err.message : String(err))
  }
}

async function record(bridge: Window["zyvroCapture"]): Promise<void> {
  const config = await bridge.recorder.config()
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })

  const video = document.createElement("video")
  video.muted = true
  video.srcObject = stream
  await video.play()
  if (video.videoWidth === 0) {
    await new Promise<void>((resolve) => video.addEventListener("resize", () => resolve(), { once: true }))
  }

  // La zone, en pixels de la piste : son rapport à l'écran se lit sur elle.
  const source = pixelRect(config.rect, config.screen, { width: video.videoWidth, height: video.videoHeight })
  const out = fitWithin(source.width, source.height, VIDEO_MAX_SIDE)
  const canvas = document.createElement("canvas")
  canvas.width = out.width
  canvas.height = out.height
  const ctx = canvas.getContext("2d", { alpha: false })
  if (!ctx) throw new Error("no drawing surface for the recording")

  const small = gifSize(out.width, out.height)
  const gifCanvas = document.createElement("canvas")
  gifCanvas.width = small.width
  gifCanvas.height = small.height
  const gifCtx = gifCanvas.getContext("2d", { alpha: false, willReadFrequently: true })
  if (!gifCtx) throw new Error("no drawing surface for the GIF")
  const clip = new GifClip(small.width, small.height, GIF_MAX_BYTES)

  const draw = () =>
    ctx.drawImage(video, source.x, source.y, source.width, source.height, 0, 0, out.width, out.height)
  draw()

  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) =>
    MediaRecorder.isTypeSupported(t)
  )
  const recorder = new MediaRecorder(canvas.captureStream(30), {
    mimeType,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  })
  const chunks: Blob[] = []
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })

  const t0 = performance.now()
  recorder.start(1000)
  await bridge.recorder.started()

  // L'heure d'abord, les pixels ensuite : la première lecture de la toile
  // initialise le GPU et prend plusieurs centaines de millisecondes, qui
  // manquaient au GIF.
  const sample = () => {
    const at = performance.now() - t0
    gifCtx.drawImage(canvas, 0, 0, out.width, out.height, 0, 0, small.width, small.height)
    clip.add(gifCtx.getImageData(0, 0, small.width, small.height).data, at)
  }
  sample()
  const drawTimer = setInterval(draw, 1000 / 30)
  const gifTimer = setInterval(sample, 1000 / GIF_FPS)

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    // Jamais plus que la limite : c'est elle que le serveur vérifie.
    const end = Math.min(performance.now() - t0, config.maxMs)
    clearInterval(drawTimer)
    clearInterval(gifTimer)
    clearTimeout(limit)
    const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }))
    recorder.stop()
    await stopped
    for (const track of stream.getTracks()) track.stop()
    const webm = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer())
    const gif = clip.finish(end)
    await bridge.recorder.done({
      webm,
      gif,
      gifTooLarge: clip.tooLarge,
      width: out.width,
      height: out.height,
      ms: Math.round(end),
    })
  }
  const limit = setTimeout(() => void stop().catch(fail), config.maxMs)
  const fail = (err: unknown) => void bridge.recorder.failed(err instanceof Error ? err.message : String(err))
  bridge.recorder.onStop(() => void stop().catch(fail))
  // L'écran partagé peut s'arrêter de lui-même (écran débranché) : on garde ce
  // qu'on a.
  stream.getVideoTracks()[0]?.addEventListener("ended", () => void stop().catch(fail))
}
