// The desktop renderer compiles the web app's components directly, and those
// components import Next.js navigation. There are no pages here: an editor tab
// is the unit of navigation. These shims keep the shared components compiling
// and route their few navigation calls into the tab store instead.
import { useMemo } from "react"
import { openRoute } from "~/state/workspace"

export type AppRouter = {
  push: (href: string) => void
  replace: (href: string) => void
  back: () => void
  forward: () => void
  refresh: () => void
  prefetch: (href: string) => void
}

export function useRouter(): AppRouter {
  // A new object every render would defeat the dependency arrays the shared
  // components put their router in, re-running their effects on every keystroke.
  return useMemo<AppRouter>(
    () => ({
      push: (href) => openRoute(href),
      replace: (href) => openRoute(href),
      back: () => undefined,
      forward: () => undefined,
      refresh: () => undefined,
      prefetch: () => undefined,
    }),
    []
  )
}

// The shared components read the pathname only to highlight navigation that the
// desktop shell does not render, so a stable constant is the honest answer.
export function usePathname(): string {
  return "/"
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams()
}

export function useParams(): Record<string, string> {
  return {}
}

export function redirect(href: string): void {
  openRoute(href)
}

export function notFound(): void {
  // Nothing to do: a tab that cannot load renders its own empty state.
}
