import { useCallback, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, Code2, RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { Splitter } from "~/panels/Splitter"

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

// Une vue vide plutôt qu'une adresse choisie pour elle : personne ne sait ce
// que cette machine sert sur le port 3000, et une page d'erreur à l'ouverture
// donne l'air d'être cassé avant même d'avoir servi.
const BLANK = "about:blank"

type Guest = Electron.WebviewTag

export function BrowserTab({ tabId, url }: { tabId: string; url: string }) {
  // `src` ne bouge jamais après le montage. Le lier à l'adresse courante ferait
  // renavigger la vue à chaque fin de chargement — une redirection suffisait à
  // relancer la page, et une page qui se recharge toute seule est exactement ce
  // qu'on est en train d'essayer de déboguer.
  const [home] = useState(url || BLANK)
  const [typed, setTyped] = useState(url)
  const setBrowserPage = useWorkspace((s) => s.setBrowserPage)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<Guest | null>(null)
  // Les outils vivent dans cette fenêtre-ci, sous la page. Ouverts dans une
  // fenêtre du système, on referme l'application en croyant fermer les outils,
  // et on les cherche derrière les autres fenêtres.
  const [tools, setTools] = useState(false)
  const [toolsHeight, setToolsHeight] = useState(320)
  // Une <webview> n'est pas interrogeable avant `dom-ready` : `canGoBack` y
  // lève, et une exception pendant le rendu emporte l'arbre entier. L'élément
  // existe donc avant d'être utilisable, et ces deux états sont distincts.
  const [ready, setReady] = useState(false)

  // React 18 ignore ce qu'une ref à rappel renvoie, donc le démontage est garé
  // ici et joué quand la ref est appelée avec null. Même mécanique que le
  // terminal : l'élément possède ses abonnements, et rien ne survit à sa
  // disparition.
  const teardown = useRef<(() => void) | null>(null)
  const teardownTools = useRef<(() => void) | null>(null)

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
      // L'identifiant de l'onglet part avec : c'est par lui qu'un agent nomme
      // la vue qu'il pilote, et le processus principal n'a aucun autre moyen de
      // relier ce contenu à ce que la personne voit dans sa barre latérale.
      void window.zyvro.browser.attach(node.getWebContentsId(), tabId)
    }
    const started = () => setLoading(true)
    // La favicon vient de la page et d'elle seule : un onglet qui garderait
    // celle du site précédent dirait qu'on est ailleurs qu'on est.
    const icon = (event: Electron.PageFaviconUpdatedEvent) => {
      setBrowserPage(tabId, node.getURL(), node.getTitle(), event.favicons[0] ?? "")
    }
    const stopped = () => {
      setLoading(false)
      const here = node.getURL() === BLANK ? "" : node.getURL()
      setTyped(here)
      // Le titre de la page devient celui de l'onglet et de la ligne dans la
      // barre latérale. Trois « Browser » ne disent pas laquelle est laquelle —
      // mais une vue encore vide s'appelle « Browser » et pas « about:blank »,
      // qui est une adresse et pas un nom.
      // L'icône n'est pas remise à zéro ici : elle arrive par son propre
      // événement, souvent après la fin du chargement. La vider à chaque arrêt
      // la ferait clignoter à chaque navigation.
      setBrowserPage(tabId, here, here ? node.getTitle() : "", here ? undefined : "")
    }

    // Les événements de la vue restent écoutés en second : ils confirment ce
    // que le bouton a déjà fait, et ils rattrapent une ouverture venue d'ailleurs
    // — le clic droit, « Inspecter » — qui ne passe pas par lui.
    const opened = () => setTools(true)
    const closed = () => setTools(false)

    // Le principal demande la vue d'accueil des outils quand il en a besoin —
    // le clic droit, « Inspecter », le bouton. Elle se monte alors, s'annonce,
    // et il y dessine son front-end.
    const offAsk = window.zyvro.browser.onDevtoolsOpen((payload) => {
      if (payload?.view === tabId) setTools(true)
    })
    const offGone = window.zyvro.browser.onDevtoolsClosed((payload) => {
      if (payload?.view === tabId) setTools(false)
    })

    node.addEventListener("dom-ready", attached)
    node.addEventListener("devtools-opened", opened)
    node.addEventListener("devtools-closed", closed)
    node.addEventListener("did-start-loading", started)
    node.addEventListener("page-favicon-updated", icon)
    node.addEventListener("did-stop-loading", stopped)
    teardown.current = () => {
      offAsk()
      offGone()
      node.removeEventListener("dom-ready", attached)
      node.removeEventListener("devtools-opened", opened)
      node.removeEventListener("devtools-closed", closed)
      node.removeEventListener("did-start-loading", started)
      node.removeEventListener("page-favicon-updated", icon)
      node.removeEventListener("did-stop-loading", stopped)
    }
  }, [tabId, setBrowserPage])

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

  // L'emplacement des outils : le rendu réserve la place, le processus
  // principal y pose sa vue.
  //
  // Les outils de Chromium ne se dessinent pas dans une page — Electron ne
  // relie son pont d'inspection qu'à une vue native. Ce div est donc un trou
  // dans la mise en page, et une ref à rappel branche un observateur de taille
  // qui dit où il est. Quand l'onglet passe en arrière-plan, il mesure zéro, et
  // la vue disparaît avec lui : sans ça elle resterait posée par-dessus
  // l'éditeur, à afficher la page d'un onglet qu'on ne regarde plus.
  const place = useCallback(
    (node: HTMLDivElement | null) => {
      const current = teardownTools.current
      teardownTools.current = null
      current?.()
      if (!node || !view || !ready) return

      const id = view.getWebContentsId()
      const report = () => {
        const box = node.getBoundingClientRect()
        void window.zyvro.browser.devtoolsBounds(id, {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        })
      }
      report()
      const watcher = new ResizeObserver(report)
      watcher.observe(node)
      teardownTools.current = () => {
        watcher.disconnect()
        void window.zyvro.browser.devtoolsBounds(id, null)
      }
    },
    [view, ready]
  )

  const toggleTools = (): void => {
    if (!view || !ready) return
    // Le panneau suit le geste, sans attendre de confirmation. À l'ouverture il
    // doit de toute façon être monté avant que le principal puisse y dessiner ;
    // à la fermeture, l'événement `devtools-closed` n'arrive pas toujours quand
    // les outils sont hébergés par une autre vue, et un panneau qui reste
    // ouvert après qu'on a cliqué sur « fermer » est un bouton cassé.
    const next = !tools
    setTools(next)
    // Sans emplacement à l'ouverture : le panneau vient de se monter, il n'est
    // pas encore mesuré. L'observateur le dira dans la foulée.
    void window.zyvro.browser.devtools(view.getWebContentsId(), next, null)
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
        {/* Le clic droit n'est pas le seul chemin, et un panneau qu'on ne sait
            pas refermer est un panneau qui reste ouvert. */}
        <button
          type="button"
          title={tools ? "Close developer tools" : "Developer tools — Elements, Console, Network, Application"}
          onClick={toggleTools}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors hover:bg-white/[0.06]",
            tools ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Code2 className="h-3.5 w-3.5" />
        </button>
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

      {/* Les outils, sous la page, dans la même fenêtre. La vue reste montée
          une fois qu'elle a servi : Electron n'accepte d'y dessiner son
          front-end que tant qu'elle n'a pas navigué ailleurs, et la remonter à
          chaque ouverture reviendrait à la lui reprendre. */}
      {tools && (
        <>
          <Splitter
            orientation="horizontal"
            onResize={(delta) => setToolsHeight((h) => Math.min(900, Math.max(120, h - delta)))}
          />
          {/* Le trou où la vue native se pose. Il ne contient rien : ce qu'on y
              voit est dessiné par-dessus, par Chromium. */}
          <div ref={place} className="shrink-0 bg-[#282828]" style={{ height: toolsHeight }} />
        </>
      )}
    </div>
  )
}
