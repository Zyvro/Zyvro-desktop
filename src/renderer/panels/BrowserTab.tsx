import { useCallback, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"

// Le navigateur de test : un onglet de l'IDE, et la page que l'agent pilote.
//
// Pourquoi il est visible plutôt que caché : c'est la moitié de l'intérêt. Un
// agent qui vérifie son travail dans une fenêtre que personne ne regarde
// raconte ce qu'il a vu ; ici on le voit cliquer, et une page qui reste blanche
// se remarque tout de suite.
//
// Pourquoi une `<webview>` et pas une `iframe` : une iframe est refusée par
// tout site qui envoie `X-Frame-Options`, ce qui inclut la plupart de ceux
// qu'on voudrait ouvrir. Une webview est un vrai onglet de Chromium, avec sa
// propre session — ni celle de l'application, ni celle du navigateur de la
// personne, donc les connexions de l'agent ne sont jamais celles de quelqu'un.
//
// Pas d'effet : la vue s'annonce au processus principal depuis une ref à
// rappel, qui rend sa fonction de démontage. C'est exactement la durée de vie
// de l'élément.

const HOME = "http://localhost:3000"

type Guest = Electron.WebviewTag

export function BrowserTab() {
  // `src` ne bouge jamais après le montage. Le lier à l'adresse courante ferait
  // renavigger la vue à chaque fin de chargement — une redirection suffisait à
  // relancer la page, et une page qui se recharge toute seule est exactement ce
  // qu'on est en train d'essayer de déboguer.
  const [home] = useState(HOME)
  const [typed, setTyped] = useState(HOME)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<Guest | null>(null)
  // Une <webview> n'est pas interrogeable avant `dom-ready` : `canGoBack` y
  // lève, et une exception pendant le rendu emporte l'arbre entier. L'élément
  // existe donc avant d'être utilisable, et ces deux états sont distincts.
  const [ready, setReady] = useState(false)

  // React 18 ignore ce qu'une ref à rappel renvoie, donc le démontage est garé
  // ici et joué quand la ref est appelée avec null. Même mécanique que le
  // terminal : l'élément possède ses abonnements, et rien ne survit à sa
  // disparition.
  const teardown = useRef<(() => void) | null>(null)

  const attach = useCallback((node: Guest | null) => {
    if (node === null) {
      const run = teardown.current
      teardown.current = null
      run?.()
      setView(null)
      setReady(false)
      return
    }
    setView(node)

    // `dom-ready` est le premier moment où le contenu existe : demandé avant,
    // `getWebContentsId` lève, et le processus principal n'aurait jamais de
    // vue à piloter.
    const attached = () => {
      setReady(true)
      void window.zyvro.browser.attach(node.getWebContentsId())
    }
    const started = () => setLoading(true)
    const stopped = () => {
      setLoading(false)
      setTyped(node.getURL())
    }

    node.addEventListener("dom-ready", attached)
    node.addEventListener("did-start-loading", started)
    node.addEventListener("did-stop-loading", stopped)
    teardown.current = () => {
      node.removeEventListener("dom-ready", attached)
      node.removeEventListener("did-start-loading", started)
      node.removeEventListener("did-stop-loading", stopped)
    }
  }, [])

  // go est la seule porte par laquelle la personne ouvre une adresse, et c'est
  // pour ça qu'elle la déclare : ce qu'on ouvre soi-même devient une origine
  // que l'agent a le droit de rouvrir. Taper une adresse est un accord, et il
  // ne vaut que pour celle-là.
  const go = (raw: string): void => {
    const next = raw.trim()
    if (!next || !view || !ready) return
    const full = /^https?:\/\//i.test(next) ? next : `https://${next}`
    void window.zyvro.browser.visited(view.getWebContentsId(), full)
    view.loadURL(full).catch(() => {
      // L'échec s'affiche dans la page elle-même, comme dans un navigateur.
    })
  }

  const can = (what: "back" | "forward"): boolean => {
    if (!view || !ready) return false
    return what === "back" ? view.canGoBack() : view.canGoForward()
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-shot-zone="Browser">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-2">
        <button
          type="button"
          title="Back"
          disabled={!can("back")}
          onClick={() => ready && view?.goBack()}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Forward"
          disabled={!can("forward")}
          onClick={() => ready && view?.goForward()}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:opacity-30"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Reload"
          onClick={() => ready && view?.reload()}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        >
          <RotateCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
        <form
          className="flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            go(typed)
          }}
        >
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            spellCheck={false}
            placeholder="localhost:3000"
            className="h-7 w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-white/20"
          />
        </form>
      </div>

      {/* eslint-disable-next-line react/no-unknown-property */}
      <webview
        ref={attach}
        src={home}
        // La session est fixée par le processus principal dans
        // `will-attach-webview` : l'écrire ici aussi ferait deux endroits qui
        // décident de la même chose, et c'est celui d'en face qui gagne.
        className="min-h-0 flex-1 bg-white"
      />
    </div>
  )
}
