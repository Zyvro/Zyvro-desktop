import type { AnchorHTMLAttributes, ReactNode } from "react"
import { openRoute } from "~/state/workspace"

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  children?: ReactNode
  prefetch?: boolean
  replace?: boolean
  scroll?: boolean
}

// An anchor in a desktop window must never actually navigate: the renderer is a
// local bundle, and following a link would replace the whole app with a blank
// page. So the href stays for styling and tooltips, and the click is redirected
// to a tab (internal) or the system browser (external).
export default function Link({ href, children, prefetch: _p, replace: _r, scroll: _s, ...rest }: LinkProps) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault()
        rest.onClick?.(event)
        if (/^https?:\/\//i.test(href)) {
          void window.zyvro.openExternal(href)
          return
        }
        openRoute(href)
      }}
    >
      {children}
    </a>
  )
}
