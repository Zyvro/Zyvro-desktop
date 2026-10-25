import { useEffect, useState } from "react"
import { findZones, zoneAt, ZONE_ATTR, type Zone } from "~/panels/ShotPicker"
import { subscribeLayout } from "~/state/layoutPrefs"

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

function sameRect(a: Zone["rect"] | undefined, b: Zone["rect"] | undefined): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function ZoneHover() {
  const [hover, setHover] = useState<Zone | null>(null)

  useEffect(() => {
    // Un minuteur de rafraîchissement plutôt qu'un reflow par pixel : la
    // souris traverse des Monaco et des xterm, et mesurer chaque frame
    // coûterait plus que le liseré ne rapporte.
    let frame = 0
    let last: Zone | null = null
    const onMove = (e: PointerEvent) => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        // Relevé à chaque geste : les panneaux bougent (séparateurs, replis).
        const zones = findZones()
        // Un bouton enfoncé : on tire un séparateur ou un panneau. Le liseré
        // reste sur la zone qu'on survolait et suit sa taille à chaque image —
        // le curseur, lui, est sur le bord, et la zone « sous lui » changerait
        // sans cesse. Avant, il ne bougeait qu'au relâchement.
        const held = e.buttons !== 0 && last ? zones.find((zone) => zone.name === last?.name) : undefined
        const z = held ?? zoneAt(zones, e.clientX, e.clientY)
        // « Window » n'est pas un champ de vision : c'est le cadre.
        const next = z && z.name !== "Window" ? z : null
        if (next?.name === last?.name && sameRect(next?.rect, last?.rect)) return
        last = next
        setHover(next)
      })
    }
    const onLeave = () => {
      last = null
      setHover(null)
    }
    // `pointermove` et pas `mousemove` : un séparateur annule son `pointerdown`
    // (pour ne pas sélectionner de texte), et le navigateur supprime alors les
    // événements souris jusqu'au relâchement — le liseré restait figé pendant
    // tout le glissement.
    window.addEventListener("pointermove", onMove, true)
    window.addEventListener("pointerup", onMove, true)
    // La fenêtre redimensionnée sous une souris immobile : même chose.
    const onResize = () => {
      last = null
      setHover(null)
    }
    window.addEventListener("resize", onResize)
    document.addEventListener("mouseleave", onLeave)
    // Les panneaux changent de côté sous une souris immobile : le liseré
    // mesuré avant resterait sur une place qui n'est plus la leur.
    const offLayout = subscribeLayout(onLeave)
    return () => {
      offLayout()
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove, true)
      window.removeEventListener("pointerup", onMove, true)
      window.removeEventListener("resize", onResize)
      document.removeEventListener("mouseleave", onLeave)
    }
  }, [])

  if (!hover) return null
  return (
    <div
      className="pointer-events-none fixed z-[90]"
      data-zone-hover={hover.name}
      // Un pixel en retrait sur chaque bord : les panneaux se séparent par un
      // trait gris d'un pixel, posé sur leur premier pixel. Le liseré tombait
      // pile dessus et en changeait la couleur ; juste à l'intérieur, il le
      // longe sans le recouvrir.
      style={{
        left: hover.rect.x + 1,
        top: hover.rect.y + 1,
        width: Math.max(0, hover.rect.width - 2),
        height: Math.max(0, hover.rect.height - 2),
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
