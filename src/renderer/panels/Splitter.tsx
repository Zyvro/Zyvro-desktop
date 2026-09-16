import { useRef, type PointerEvent as ReactPointerEvent } from "react"
import { cn } from "@/lib/utils"

type Props = {
  orientation: "vertical" | "horizontal"
  onResize: (deltaPx: number) => void
  className?: string
}

// A drag handle built entirely out of pointer events on the handle itself.
// Pointer capture is what makes that possible: once captured, the element keeps
// receiving moves even when the cursor races ahead of it, so there is no need
// to attach listeners to the window and therefore no subscription to tear down.
export function Splitter({ orientation, onResize, className }: Props) {
  const last = useRef(0)
  const vertical = orientation === "vertical"

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    last.current = vertical ? event.clientX : event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const position = vertical ? event.clientX : event.clientY
    const delta = position - last.current
    if (delta === 0) return
    last.current = position
    onResize(delta)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn(
        "group relative z-10 shrink-0 bg-transparent",
        vertical ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className={cn("absolute bg-white/[0.06]", vertical ? "inset-y-0 w-px" : "inset-x-0 h-px")} />
      {/* The visible line is one pixel; this invisible strip is what the user
          actually has to hit, which needs to be several. */}
      <div
        className={cn(
          "absolute transition-colors group-hover:bg-primary/40",
          vertical ? "inset-y-0 -left-1 w-3" : "inset-x-0 -top-1 h-3"
        )}
      />
    </div>
  )
}
