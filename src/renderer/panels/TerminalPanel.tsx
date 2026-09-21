import { useCallback, useRef, useState, useSyncExternalStore } from "react"
import { Terminal, type ITheme } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Plus, RotateCcw, TerminalSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { droppedText } from "../../shared/dropped"
import { carriesPaths, droppedPaths } from "~/state/dropped"
import { subscribeHandoff, takeHandoff, tokenOf } from "~/state/handoff"
import { useWorkspace } from "../state/workspace"
import { openToken, sessionsChanged, subscribeOpen, takeOpen } from "~/state/persistent"
import { ShellPicker } from "./ShellPicker"

// The integrated shell is where `claude` and `codex` actually run, so a session
// has to survive everything the UI does to it: switching tabs, resizing the
// panel, opening another shell. That rules out unmounting a hidden session, and
// it rules out rebuilding the xterm instance on re-render. Everything below is
// arranged around keeping one xterm alive per session key for as long as the
// tab exists.

// ---------------------------------------------------------------------------
// Session status store
// ---------------------------------------------------------------------------

// The pty id and the exit code both arrive from outside React — one from an
// `invoke` reply, the other from an IPC event — so they live in a module store
// read through useSyncExternalStore rather than being pushed into state from an
// effect. `generation` is what a Restart bumps: it is used as the React key of
// the terminal host node, so a restart unmounts the old node (running the
// callback ref's teardown) and mounts a fresh one.
type SessionStatus = {
  ptyId: string | null
  /** False when the main process fell back to pipes, which cannot be resized. */
  pty: boolean
  exitCode: number | null
  generation: number
  /**
   * Ce que ce shell avait écrit la dernière fois, à réafficher au-dessus de
   * l'invite neuve. Vide dans le cas courant.
   */
  history?: string
  /** Le dossier où ce shell était à la fermeture, pour l'y rouvrir. */
  cwd?: string
  /**
   * L'étiquette d'une session persistante, quand ce shell en est le client.
   *
   * Présente avant l'ouverture — c'est elle qui dit à la référence de rappel
   * d'attacher une session plutôt que de lancer un shell — et remplacée par le
   * nom réel une fois la session ouverte.
   */
  persistent?: string
}

const IDLE: SessionStatus = { ptyId: null, pty: true, exitCode: null, generation: 0 }

const statuses = new Map<string, SessionStatus>()
const listeners = new Map<string, Set<() => void>>()

// getSnapshot must return a cached value: building `{...}` here would hand
// React a new object on every call and re-render forever.
function readStatus(key: string): SessionStatus {
  return statuses.get(key) ?? IDLE
}

function subscribeStatus(key: string, listener: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(key)
  }
}

function patchStatus(key: string, patch: Partial<SessionStatus>): void {
  statuses.set(key, { ...readStatus(key), ...patch })
  const set = listeners.get(key)
  if (!set) return
  for (const listener of [...set]) listener()
}

function forgetStatus(key: string): void {
  statuses.delete(key)
}

function restartSession(key: string): void {
  const current = readStatus(key)
  patchStatus(key, { ptyId: null, exitCode: null, generation: current.generation + 1 })
}

// Imperative handles for a live session, registered by the callback ref and
// dropped by its teardown. Activating a tab is a user action, so re-fitting the
// shell that just became visible belongs in the click handler.
type SessionHandle = { fit: () => void; focus: () => void }
const handles = new Map<string, SessionHandle>()

let sessionCounter = 0
function nextSessionKey(): string {
  sessionCounter += 1
  return `shell-${sessionCounter}`
}

// ---------------------------------------------------------------------------
// xterm wiring
// ---------------------------------------------------------------------------

const THEME: ITheme = {
  background: "#0b0b0f",
  foreground: "#e5e5ea",
  cursor: "#e5e5ea",
  cursorAccent: "#0b0b0f",
  selectionBackground: "#2c2c39",
  black: "#1a1a1f",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#f2cc60",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#76e3ea",
  white: "#c9c9d1",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#a7f3a0",
  brightYellow: "#ffd866",
  brightBlue: "#a5d6ff",
  brightMagenta: "#e2c5ff",
  brightCyan: "#a5f3f0",
  brightWhite: "#f5f5f7",
}

const FONT_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

function hasSize(node: HTMLElement): boolean {
  return node.clientWidth > 0 && node.clientHeight > 0
}

// mountTerminal owns one shell end to end. It returns the teardown the callback
// ref runs when the node goes away, which is the only place a session is ever
// destroyed.
function mountTerminal(node: HTMLDivElement, key: string): () => void {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: FONT_STACK,
    fontSize: 12.5,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: THEME,
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  // Links open in the user's browser rather than in a webview; an Electron
  // window navigating away from the app would take the whole IDE with it.
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      void window.zyvro.openExternal(uri)
    })
  )

  term.open(node)
  if (hasSize(node)) fitAddon.fit()

  let ptyId: string | null = null
  let disposed = false

  // A login shell prints its banner and prompt immediately, and those events
  // can reach the renderer before the `terminal:create` reply does. Buffering
  // every event until this session knows its own id is what keeps the first
  // prompt from disappearing; ids that are not ours are simply dropped, since
  // the session they belong to buffers them itself.
  const early: { id: string; data: string }[] = []
  let earlyExit: { id: string; code: number } | null = null

  const offData = window.zyvro.terminal.onData((payload) => {
    if (ptyId === null) {
      early.push(payload)
      return
    }
    if (payload.id === ptyId) term.write(payload.data)
  })

  const offExit = window.zyvro.terminal.onExit((payload) => {
    if (ptyId === null) {
      if (earlyExit === null) earlyExit = payload
      return
    }
    if (payload.id === ptyId) {
      patchStatus(key, { exitCode: payload.code })
      // Une session persistante dont le client meurt : soit elle a fini, soit
      // quelqu'un l'a tuée. Dans les deux cas la liste doit aller revoir — elle
      // ne peut pas le deviner, et attendre son prochain tour de sondage
      // laisserait une ligne morte à l'écran.
      if (readStatus(key).persistent !== undefined) sessionsChanged()
    }
  })

  const input = term.onData((data) => {
    if (ptyId !== null) void window.zyvro.terminal.write(ptyId, data)
  })

  const pushSize = (): void => {
    if (!hasSize(node)) return
    fitAddon.fit()
    if (ptyId !== null) void window.zyvro.terminal.resize(ptyId, term.cols, term.rows)
  }

  // A hidden tab measures 0x0, and fitting against that collapses the terminal
  // to one column and corrupts the reflowed scrollback. Skipping the zero-size
  // callback also gives us the re-fit on show for free: unhiding the wrapper
  // resizes this node, which fires the observer again with a real size.
  const observer = new ResizeObserver(pushSize)
  observer.observe(node)

  // Lâcher un fichier ici écrit son chemin, comme si on l'avait tapé.
  //
  // En natif et pas par React : ce sous-arbre est celui de xterm, et React ne
  // distribue pas les événements qui y naissent — un `onDrop` posé sur le
  // conteneur n'est jamais appelé. Vérifié : l'événement passe bien sur le
  // nœud, et la fonction React ne s'exécute pas.
  const onDragOver = (event: DragEvent): void => {
    if (carriesPaths(event)) event.preventDefault()
  }
  const onDrop = (event: DragEvent): void => {
    const paths = droppedPaths(event)
    if (paths.length === 0 || ptyId === null) return
    event.preventDefault()
    const text = droppedText(paths, window.zyvro.platform)
    if (text) void window.zyvro.terminal.write(ptyId, text)
  }
  node.addEventListener("dragover", onDragOver)
  node.addEventListener("drop", onDrop)

  handles.set(key, { fit: pushSize, focus: () => term.focus() })

  // Adopter plutôt que créer, quand ce shell existe déjà.
  //
  // Après un rechargement du rendu, les ptys sont toujours là — ce sont des
  // enfants du processus principal, une page qui recharge ne les tue pas, elle
  // les oublie. Le panneau a repris leurs identifiants avant de monter ces
  // composants ; il ne reste qu'à s'y brancher et à redemander ce qui a défilé.
  const dejaLa = readStatus(key).ptyId
  const persiste = readStatus(key).persistent
  const ouvrir = dejaLa
    ? Promise.resolve({ id: dejaLa, pty: readStatus(key).pty, banner: undefined, reprise: true })
    : persiste !== undefined
      ? // Une session persistante : on n'est que son client. Fermer cet onglet
        // la détachera au lieu de la tuer — c'est toute la différence, et c'est
        // ce que `tmux` et `screen` savent faire et que nous ne savons pas.
        window.zyvro.persistent
          .open(persiste, term.cols, term.rows)
          .then((session) => {
            patchStatus(key, { persistent: session.label })
            // Le moment exact où elle existe : `tmux`/`screen` vient de la
            // rendre. La liste l'apprend maintenant plutôt qu'à son prochain
            // tour de sondage.
            sessionsChanged()
            return { ...session, reprise: false }
          })
      : window.zyvro.terminal
          .create(term.cols, term.rows, readStatus(key).cwd)
          .then((session) => ({ ...session, reprise: false }))

  void ouvrir
    .then((session) => {
      if (disposed) {
        // The tab was closed while the shell was still being spawned. Nothing
        // is listening any more, so kill it rather than leak a login shell.
        void window.zyvro.terminal.dispose(session.id)
        return
      }
      ptyId = session.id
      patchStatus(key, { ptyId: session.id, pty: session.pty })
      // Ce que ce shell a de branché, écrit avant tout le reste : la sortie du
      // shell attend dans `early`, donc le bandeau reste au-dessus de la
      // première invite au lieu de tomber au milieu.
      // Le défilement d'avant, tout en haut : au-dessus du bandeau et de la
      // première invite, comme il l'était à l'écran la dernière fois.
      const avant = readStatus(key).history
      if (avant) {
        term.write(avant)
        // Une ligne qui dit franchement que ce qui précède est du passé : sans
        // elle, on relit une compilation d'hier en croyant qu'elle tourne.
        term.write("\r\n\u001b[2m— session précédente, les programmes ont été arrêtés —\u001b[0m\r\n")
        patchStatus(key, { history: undefined, cwd: undefined })
      }
      if (session.banner) term.write(session.banner)
      // Lié d'abord, rejoué ensuite : les données portent l'identifiant du
      // shell, et une page qui ne l'a pas encore adopté les mettrait dans
      // `early` une seconde fois.
      if (session.reprise) void window.zyvro.terminal.replay(session.id)
      for (const payload of early) {
        if (payload.id === session.id) term.write(payload.data)
      }
      early.length = 0
      const pendingExit = earlyExit
      earlyExit = null
      if (pendingExit !== null && pendingExit.id === session.id) {
        patchStatus(key, { exitCode: pendingExit.code })
      }
      term.focus()
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      term.write(`\r\n\x1b[31mCould not start a shell: ${message}\x1b[0m\r\n`)
    })

  return () => {
    disposed = true
    observer.disconnect()
    node.removeEventListener("dragover", onDragOver)
    node.removeEventListener("drop", onDrop)
    handles.delete(key)
    offData()
    offExit()
    input.dispose()
    if (ptyId !== null) void window.zyvro.terminal.dispose(ptyId)
    term.dispose()
  }
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

function TerminalSession({ sessionKey, active }: { sessionKey: string; active: boolean }): JSX.Element {
  const status = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeStatus(sessionKey, listener), [sessionKey]),
    useCallback(() => readStatus(sessionKey), [sessionKey])
  )

  // React 18 ignores a value returned from a callback ref, so the teardown is
  // parked here and invoked when the ref is called with null.
  const teardown = useRef<(() => void) | null>(null)

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        const run = teardown.current
        teardown.current = null
        run?.()
        return
      }
      teardown.current = mountTerminal(node, sessionKey)
    },
    [sessionKey]
  )

  return (
    <div className={cn("absolute inset-0 flex flex-col", !active && "hidden")}>
      {/* The React key is the restart mechanism: bumping the generation remounts
          this node, which runs the ref teardown and then a fresh mount. */}
      <div key={status.generation} ref={attach} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />

      {status.exitCode !== null ? (
        <div className="flex items-center gap-3 border-t border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-[11px]">
          <span className="text-muted-foreground">
            Shell exited with code{" "}
            <span className={cn("font-mono", status.exitCode === 0 ? "text-foreground" : "text-red-400")}>
              {status.exitCode}
            </span>
          </span>
          <button
            type="button"
            onClick={() => restartSession(sessionKey)}
            className="inline-flex items-center gap-1 rounded border border-white/[0.06] bg-white/[0.04] px-2 py-0.5 text-foreground transition-colors hover:bg-white/[0.08]"
          >
            <RotateCcw className="h-3 w-3" />
            Restart
          </button>
        </div>
      ) : null}

      {status.ptyId !== null && !status.pty ? (
        <div className="border-t border-white/[0.06] bg-white/[0.02] px-3 py-1 text-[11px] text-muted-foreground">
          Running without a native pty — the window size is fixed for this session.
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function TerminalPanel(): JSX.Element {
  // Le dossier où l'on travaille, pas le projet ouvert. Sans projet, c'est
  // celui d'accueil : « les shells, pareil » — par projet s'il y en a un,
  // globaux sinon. Il sert aussi de nom sous lequel le défilement est gardé,
  // donc les shells de la maison se retrouvent comme ceux d'un projet.
  const projectDir = useWorkspace((state) => state.root)

  const [sessions, setSessions] = useState<string[]>([])
  const [activeKey, setActiveKey] = useState("")
  const [boundProject, setBoundProject] = useState<string | null>(null)

  // Ce que l'arbre nous remet : « ouvrir dans le terminal », c'est un `cd` écrit
  // dans le shell actif.
  //
  // Écrit, et pas exécuté à sa place : la ligne arrive avec son retour à la
  // ligne parce que c'est ce qu'on demande — mais elle arrive dans le shell de
  // quelqu'un, qui la voit, qui a son historique, et qui peut remonter dessus.
  // Un `cd` est ce qu'il y a de plus inoffensif à envoyer ainsi ; rien d'autre
  // ne passe par ce canal.
  const remis = useSyncExternalStore(subscribeHandoff("terminal"), () => tokenOf("terminal"), () => 0)
  const attendait = useRef(0)
  if (remis !== attendait.current) {
    attendait.current = remis
    // Prise après le rendu, comme la demande d'ouverture juste en dessous et
    // pour la même raison : en développement React rend deux fois et jette le
    // premier passage, donc un jeton pris pendant le rendu est consommé par
    // celui qu'on jette. Le `cd` n'arrivait jamais dans le shell.
    window.queueMicrotask(() => {
      const ligne = takeHandoff("terminal")
      const ptyId = readStatus(activeKey).ptyId
      // Sans shell vivant il n'y a nulle part où écrire : mieux vaut ne rien
      // faire que d'en ouvrir un qui surprendrait.
      if (ligne && ptyId) void window.zyvro.terminal.write(ptyId, ligne)
    })
  }

  // Adjusting state during render, not in an effect. A pty's cwd is fixed when
  // it spawns, so every shell belongs to exactly one project: opening ANOTHER
  // project has to discard the old sessions and start one in the new directory.
  // Calling setState here re-renders before anything is committed, which is the
  // supported way to react to a changed input.
  //
  // **Un autre projet, oui. « On ne sait pas », jamais.**
  //
  // Signalé par Jeremy le 18/09 avec un cas précis : kryone2.0 ouvert, trois
  // shells lancés — le front, le CDN, `sh debug.sh` — et une trentaine de
  // secondes plus tard les trois fermés ensemble. Trois shells ne meurent pas
  // chacun de leur côté : c'est ici qu'on les jette, et jeter une session
  // démonte son composant, dont la fermeture appelle `terminal.dispose` et tue
  // le pty. Trois programmes perdus, sans un mot.
  //
  // La branche d'avant traitait `null` comme « le projet est fermé ». Or `null`
  // est aussi ce qu'on a quand la requête qui porte le projet cligne — une
  // invalidation, un rechargement du rendu, une réponse qui arrive vide une
  // fraction de seconde. Le prix d'une hésitation d'affichage était trois
  // serveurs de développement.
  //
  // Ne rien faire sur `null` est sans danger : les shells vivent dans le
  // processus principal, leur cwd n'a pas bougé, et si le même projet revient
  // ce sont encore les bons. On ne retient pas non plus le `null` dans
  // `boundProject`, sinon le retour du chemin passerait pour un changement de
  // projet et les remplacerait quand même.
  if (projectDir !== null && projectDir !== boundProject) {
    for (const key of sessions) forgetStatus(key)
    setBoundProject(projectDir)
    // La liste reste vide le temps de demander au processus principal s'il lui
    // reste des shells de ce projet : en ouvrir un tout de suite en ferait un
    // de trop à côté de ceux qu'on s'apprête à reprendre. C'est un aller-retour
    // sur la boucle locale, pas une attente.
    setSessions([])
    setActiveKey("")
    // Hors du rendu : appeler quelque chose d'asynchrone pendant qu'on dessine
    // est la porte d'entrée des rendus en boucle.
    window.queueMicrotask(() => void reprendre(projectDir))
  }

  // poser : installer les onglets repris sans écraser ce qui est arrivé entre-temps.
  //
  // `reprendre` demande au processus principal, ce qui prend un aller-retour.
  // Pendant ce temps, quelqu'un peut cliquer une session persistante dans la
  // barre latérale — et un `setSessions(keys)` sec effacerait l'onglet qu'on
  // vient d'ouvrir, sans rien dire. Le clic paraît alors n'avoir aucun effet,
  // ce qui est exactement ce que Jeremy a décrit.
  //
  // Une fusion plutôt qu'un remplacement : ce qui a été repris d'abord, ce qui
  // est arrivé pendant l'attente ensuite.
  const poser = (keys: string[]): void => {
    setSessions((actuelles) => [...keys, ...actuelles.filter((key) => !keys.includes(key))])
    setActiveKey((actuelle) => (actuelle === "" ? (keys[0] ?? "") : actuelle))
  }

  // reprendre : adopter les shells que le processus principal a gardés.
  //
  // Trouvé en creusant tmux avec Jeremy : un rechargement du rendu abandonnait
  // les shells sans les tuer. Ils continuaient d'écrire dans le vide,
  // injoignables jusqu'à la fermeture de la fenêtre, pendant que la page neuve
  // en ouvrait un de plus à côté — une fuite, et un serveur de développement
  // qu'on croyait perdu alors qu'il tournait toujours.
  //
  // Le statut est semé AVANT que les composants montent : c'est lui qui dit à
  // la référence de rappel d'adopter au lieu de créer.
  const reprendre = async (dir: string): Promise<void> => {
    const vivants = await window.zyvro.terminal.running().catch(() => [])
    // Le projet a pu changer pendant l'aller-retour. Adopter les shells d'un
    // dossier qu'on ne regarde plus donnerait des invites qui mentent sur
    // l'endroit où l'on se trouve.
    if ((useWorkspace.getState().project?.project ?? null) !== dir) return
    if (vivants.length === 0) {
      // Aucun shell vivant : la fenêtre a été fermée entre-temps et les
      // programmes sont morts avec elle — mesuré, un `npm run dev` est bien tué
      // avec tout son arbre. Ce qui reste, c'est ce qu'ils ont dit, et Jeremy
      // l'a demandé ainsi : « on rouvre le projet, bam, on a toujours nos
      // shells, avec nos programmes tués mais au moins une partie de
      // l'historique ».
      const passe = await window.zyvro.terminal.saved().catch(() => [])
      if ((useWorkspace.getState().project?.project ?? null) !== dir) return
      const keys = (passe.length > 0 ? passe : [{ seen: "", cwd: "" }]).map((shell) => {
        const key = nextSessionKey()
        // Le dossier suit le défilement : rouvrir à la racine pendant que
        // l'écran montre du travail fait dans `server/` est un écran qui ment.
        if (shell.seen || shell.cwd) patchStatus(key, { history: shell.seen, cwd: shell.cwd })
        return key
      })
      poser(keys)
      return
    }
    const keys = vivants.map((vivant) => {
      const key = nextSessionKey()
      // L'étiquette suit : un onglet repris doit garder son nom de session,
      // pas redevenir « Shell 2 ».
      patchStatus(key, { ptyId: vivant.id, pty: vivant.pty, persistent: vivant.label })
      return key
    })
    poser(keys)
  }

  // Ce que la barre latérale demande d'ouvrir.
  //
  // Même mécanique que la boîte de `handoff` : un jeton qui change à chaque
  // demande, pris une fois. Lire l'étiquette sans la prendre ouvrirait une
  // seconde session au rendu suivant.
  //
  // **Prise après le rendu, pas pendant.** C'est ce qui manquait, et le défaut
  // n'existait qu'en développement — ce qui est exactement là où Jeremy
  // travaille. En `StrictMode`, React rend chaque composant deux fois et jette
  // le premier passage : la demande était consommée par ce passage-là, et ses
  // mises à jour partaient avec lui. Résultat mesuré dans une vraie app en mode
  // dev : on tape un nom, on valide, et il ne se passe rien du tout — pas de
  // session, pas d'onglet, pas de message. En production le double rendu
  // n'existe pas, donc tout marchait, ce qui est la pire façon pour un défaut
  // de se cacher.
  //
  // `queueMicrotask` est la réponse que la doctrine prévoit pour un effet :
  // le repère change pendant le rendu — c'est une écriture idempotente — et la
  // prise, qui ne l'est pas, attend que le rendu soit acquis. Si deux passages
  // en mettaient deux en file, le second `takeOpen()` rendrait `null` et ne
  // ferait rien : la seule façon sûre d'écrire ceci est d'être rejouable.
  const demande = useSyncExternalStore(subscribeOpen, openToken, () => 0)
  const vueDemande = useRef(0)
  if (demande !== vueDemande.current) {
    vueDemande.current = demande
    window.queueMicrotask(() => {
      const label = takeOpen()
      if (label === null) return
      const key = nextSessionKey()
      patchStatus(key, { persistent: label })
      setSessions((actuelles) => [...actuelles, key])
      setActiveKey(key)
    })
  }

  const activate = (key: string): void => {
    setActiveKey(key)
    // The wrapper is unhidden in this commit, so the fit has to wait for the
    // browser to give the node a size again.
    requestAnimationFrame(() => {
      const handle = handles.get(key)
      handle?.fit()
      handle?.focus()
    })
  }

  const addSession = (): void => {
    const key = nextSessionKey()
    setSessions((current) => [...current, key])
    setActiveKey(key)
  }

  const closeSession = (key: string): void => {
    setSessions((current) => {
      const index = current.indexOf(key)
      if (index < 0) return current
      const next = current.filter((item) => item !== key)
      if (key === activeKey) {
        const fallback = next[Math.min(index, next.length - 1)] ?? ""
        setActiveKey(fallback)
        if (fallback) requestAnimationFrame(() => handles.get(fallback)?.fit())
      }
      return next
    })
    forgetStatus(key)
  }

  if (projectDir === null) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-8 shrink-0 items-center border-b border-white/[0.06] px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
          Terminal
        </div>
        <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">
          Open a project to start a shell here.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-1.5">
        {sessions.map((key, index) => {
          const isActive = key === activeKey
          return (
            <div
              key={key}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors",
                isActive
                  ? "bg-white/[0.06] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <button
                type="button"
                onClick={() => activate(key)}
                className="inline-flex items-center gap-1.5"
                title={readStatus(key).persistent ?? `Shell ${index + 1}`}
              >
                <TerminalSquare className="h-3 w-3" />
                {readStatus(key).persistent ?? `Shell ${index + 1}`}
              </button>
              <button
                type="button"
                onClick={() => closeSession(key)}
                title="Close shell"
                className={cn(
                  "rounded p-0.5 text-muted-foreground transition-opacity hover:bg-white/[0.08] hover:text-foreground",
                  isActive ? "opacity-70" : "opacity-0 group-hover:opacity-70"
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={addSession}
          title="New shell"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {/* Poussé à droite par son propre `ml-auto` : les onglets défilent, et
            un séparateur élastique entre eux et lui se ferait écraser. */}
        <ShellPicker />
      </div>

      {/* Every session stays mounted. Hiding the wrapper (never the xterm host
          itself) keeps the instance, its pty and its scrollback alive. */}
      <div className="relative min-h-0 flex-1">
        {sessions.map((key) => (
          <TerminalSession key={key} sessionKey={key} active={key === activeKey} />
        ))}
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No shell open.
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default TerminalPanel
