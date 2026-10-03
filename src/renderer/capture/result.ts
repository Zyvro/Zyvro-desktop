// Ce qu'on fait d'une capture : la copier, la garder, la publier.
//
// Publier rend un lien public qui dure un jour ; la fenêtre le dit avant
// qu'on clique, pas après. Le lien est déjà dans le presse-papier quand il
// s'affiche.

import { formatElapsed } from "../../shared/capture"
import type { CaptureView, PublishedView } from "../../preload/capture"
import { el } from "./dom"

export async function start(): Promise<void> {
  const bridge = window.zyvroCapture
  const capture = await bridge.result.current()
  if (!capture) {
    void bridge.result.close()
    return
  }

  const close = el("button", { className: "icon", title: "Close (Esc)", textContent: "×" })
  close.addEventListener("click", () => void bridge.result.close())
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void bridge.result.close()
  })

  const details =
    capture.kind === "image"
      ? `${capture.width} × ${capture.height}`
      : `${capture.width} × ${capture.height} · ${formatElapsed(capture.ms)}`
  const header = el(
    "header",
    {},
    el("strong", { textContent: capture.kind === "image" ? "Screenshot" : "Recording" }),
    el("span", { className: "muted", textContent: details }),
    close
  )

  const preview = el("div", { className: "preview" })
  if (capture.kind === "image") {
    preview.append(el("img", { src: capture.preview, alt: "The capture" }))
  } else {
    const url = URL.createObjectURL(new Blob([capture.webm as BlobPart], { type: "video/webm" }))
    preview.append(el("video", { src: url, autoplay: true, loop: true, muted: true, playsInline: true }))
  }

  const status = el("p", { className: "status" })
  const say = (text: string, kind: "info" | "error" = "info") => {
    status.textContent = text
    status.dataset.kind = kind
  }

  const actions = el("div", { className: "actions" })
  const button = (label: string, run: () => Promise<void>) => {
    const b = el("button", { textContent: label })
    b.addEventListener("click", () => {
      b.disabled = true
      run()
        .catch((err: unknown) => say(err instanceof Error ? err.message : String(err), "error"))
        .finally(() => {
          b.disabled = false
        })
    })
    return b
  }
  const saved = (file: string | null) => {
    if (file) say(`Saved to ${file}`)
  }
  if (capture.kind === "image") {
    actions.append(
      button("Copy", async () => {
        await bridge.result.copyImage()
        say("Image copied.")
      }),
      button("Save…", async () => saved(await bridge.result.save("png")))
    )
  } else {
    actions.append(button("Save WebM…", async () => saved(await bridge.result.save("webm"))))
    if (capture.hasGif) actions.append(button("Save GIF…", async () => saved(await bridge.result.save("gif"))))
  }

  const kept = keptLine(capture, () => void bridge.result.reveal())
  const publishing = publishSection(capture, say)

  document.body.append(
    el("main", { className: "result" }, header, preview, ...(kept ? [kept] : []), actions, publishing, status)
  )
}

function keptLine(capture: CaptureView, reveal: () => void): HTMLElement | null {
  if (!capture.kept) return null
  const show = el("button", { className: "link", textContent: "Show" })
  show.addEventListener("click", reveal)
  return el("p", { className: "muted kept" }, `A copy is in ${capture.kept} `, show)
}

function publishSection(capture: CaptureView, say: (text: string, kind?: "info" | "error") => void): HTMLElement {
  const bridge = window.zyvroCapture
  const section = el("section", { className: "publish" })

  if (!capture.signedIn) {
    const open = el("button", { textContent: "Open Zyvro Studio" })
    open.addEventListener("click", () => void bridge.result.openStudio())
    section.append(el("p", { className: "muted", textContent: "Sign in to Zyvro Studio to publish captures online." }), open)
    return section
  }

  const note = el("p", {
    className: "muted",
    textContent: "Publishing makes a public link: anyone who has it can open the capture for 24 hours.",
  })
  if (capture.kind === "video" && capture.gifTooLarge) {
    note.textContent += " This recording is too busy for a GIF under 40 MB, so only the video is published."
  }
  const publish = el("button", { className: "primary", textContent: "Publish Online" })
  publish.addEventListener("click", () => {
    publish.disabled = true
    publish.textContent = "Publishing…"
    bridge.result
      .publish()
      .then((published) => {
        section.replaceChildren(...links(capture, published))
        say("Link copied to the clipboard.")
      })
      .catch((err: unknown) => {
        publish.disabled = false
        publish.textContent = "Publish Online"
        say(err instanceof Error ? err.message : String(err), "error")
      })
  })
  section.append(publish, note)
  return section
}

function links(capture: CaptureView, published: PublishedView): HTMLElement[] {
  const bridge = window.zyvroCapture
  const row = (label: string, url: string) => {
    const field = el("input", { value: url, readOnly: true })
    field.addEventListener("focus", () => field.select())
    const copy = el("button", { textContent: "Copy" })
    copy.addEventListener("click", () => {
      void bridge.result.copyText(url).then(() => {
        copy.textContent = "Copied"
        setTimeout(() => (copy.textContent = "Copy"), 1500)
      })
    })
    return el("div", { className: "link-row" }, el("span", { className: "muted", textContent: label }), field, copy)
  }
  const out = [row(capture.kind === "image" ? "Link" : "Video", published.url)]
  if (published.gifUrl) out.push(row("GIF", published.gifUrl))
  const expires = published.expiresAt ? new Date(published.expiresAt) : null
  out.push(
    el("p", {
      className: "muted",
      textContent: expires
        ? `Public until ${expires.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`
        : "Public for 24 hours.",
    })
  )
  return out
}
