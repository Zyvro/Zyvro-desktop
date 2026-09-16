import type { ImgHTMLAttributes } from "react"

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string
  alt: string
  width?: number
  height?: number
  fill?: boolean
  priority?: boolean
  unoptimized?: boolean
}

// next/image exists to talk to Next's optimizer, which is a server. There is no
// server here, so the component is a plain img that accepts the same props.
export default function Image({ fill, priority: _p, unoptimized: _u, style, ...rest }: ImageProps) {
  return (
    <img
      {...rest}
      style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style } : style}
    />
  )
}
