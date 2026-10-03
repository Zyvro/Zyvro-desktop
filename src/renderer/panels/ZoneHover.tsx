import { useEffect, useState } from "react"
import { findZones, zoneAt, ZONE_ATTR, type Zone } from "~/panels/ShotPicker"

// Le champ de vision sous le curseur, dit d'un liseré.
//
// Demande de Jeremy : « un leger indicateur de zone de survol quand on survol
// une zone de l'editeur pour voir un tout petit peu la ou est note champ de
// vision ». Un coup d'œil, pas un mode : le trait est à peine visible, et il
// disparaît dès que la souris sort.
//
// La zone visée est la plus petite sous le curseur — la même règle que le
// sélecteur de capture. Sans ça, survoler l'éditeur allumerait la fenêtre
// entière (`data-shot-zone="Window"` englobe tout), et l'indicateur ne
// dirait rien.

export function ZoneHover() {
  const [hover, setHover] = useState<Zone | null>(null)

  useEffect(() => {
    // Un minuteur de rafraîchissement plutôt qu'un reflow par pixel : la
    // souris traverse des Monaco et des xterm, et mesurer chaque frame
    // coûterait plus que le liseré ne rapporte.
    let frame = 0
    let last: Zone | null = null
    const onMove = (e: MouseEvent) => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        // Relevé à chaque geste : les panneaux bougent (séparateurs, replis).
        const z = zoneAt(findZones(), e.clientX, e.clientY)
        // « Window » n'est pas un champ de vision : c'est le cadre.
        const next = z && z.name !== "Window" ? z : null
        if (next?.name === last?.name) return
        last = next
        setHover(next)
      })
    }
    const onLeave = () => {
      last = null
      setHover(null)
    }
    window.addEventListener("mousemove", onMove, true)
    document.addEventListener("mouseleave", onLeave)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("mouseleave", onLeave)
    }
  }, [])

  if (!hover) return null
  return (
    <div
      className="pointer-events-none fixed z-[90]"
      data-zone-hover={hover.name}
      style={{
        left: hover.rect.x,
        top: hover.rect.y,
        width: hover.rect.width,
        height: hover.rect.height,
        // Un liseré, rien d'autre : pas de fond, pas de nom. « Un tout petit
        // peu », pas un mode capture.
        boxShadow: "inset 0 0 0 1px rgb(56 189 248 / 0.22)",
        borderRadius: 2,
      }}
    />
  )
}

// Réexporté pour que le garde sache où regarder.
export { ZONE_ATTR }
