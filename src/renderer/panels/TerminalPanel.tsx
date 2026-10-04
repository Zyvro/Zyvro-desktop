import { useCallback, useRef, useState, useSyncExternalStore } from "react"
import { Terminal, type ITheme } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Columns2, Plus, RotateCcw, TerminalSquare, X } from "lucide-react"
import { addGroup, groupOf, placeIn, removeKey, resizePair, splitBeside, withRestored, type Groups } from "../../shared/termgroups"
import { splitToken, subscribeSplit } from "~/state/terminalSplit"
import { cn } from "@/lib/utils"
import { type AgentKind, harness } from "../../shared/harness"
import { droppedText } from "../../shared/dropped"
import { estEffacement, findPathLinks, toProjectPath, type PathLink } from "../../shared/termlinks"
import { revealAt } from "~/state/reveal"
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
   * L'étiquette d'une session persistante, quand ce shell en est le client.
  /**
   * L'étiquette d'une session persistante, quand ce shell en est le client.
   *
   * Présente avant l'ouverture — c'est elle qui dit à la référence de rappel
   * d'attacher une session plutôt que de lancer un shell — et remplacée par le
   * nom réel une fois la session ouverte.
   */
  persistent?: string
  /**
   * Le harnais que ce shell lance, quand il en lance un.
   *
   * Présent avant l'ouverture — c'est lui qui dit à la référence de rappel de
   * lancer `claude` plutôt qu'un shell de connexion — et il reste ensuite pour
   * que l'onglet porte son nom plutôt que « Shell 3 ».
   */
  harnais?: { nom: AgentKind; model: string | null; conversation?: string | null }
  /** Le harnais que ce shell installe : `npm install -g`, dans son onglet. */
  installation?: AgentKind
  connexion?: AgentKind
}

const IDLE: SessionStatus = { ptyId: null, pty: true, exitCode: null, generation: 0 }

// Ce que l'onglet porte. Une session persistante a son étiquette, un harnais a
// son nom et son modèle — deux shells du même harnais sur deux modèles sont
// exactement ce qu'on ouvre quand on compare, et « Shell 2 » et « Shell 3 » ne
// diraient pas lequel est lequel.
function nomOnglet(key: string, index: number): string {
  const statut = readStatus(key)
  if (statut.persistent !== undefined) return statut.persistent
  if (statut.connexion) return `login ${harness(statut.connexion).bin}`
  if (statut.installation) return `install ${harness(statut.installation).bin}`
  const harnais = statut.harnais
  if (harnais) return harnais.model ? `${harnais.nom} · ${harnais.model}` : harnais.nom
  return `Shell ${index + 1}`
}

const statuses = new Map<string, SessionStatus>()
const listeners = new Map<string, Set<() => void>>()

// La disposition des shells, par projet. Un shell vit dans le projet où il est
// né (son cwd ne change pas) ; basculer de projet ne doit le ni montrer ni
// tuer — seulement changer quelle disposition est à l'écran. Les composants
// xterm de TOUS les projets restent montés : les démonter tuerait les ptys
// (voir le teardown de `mountTerminal`).
type TermLayout = { groups: Groups; activeKey: string; poids: Record<string, number> }
const layoutsByProject = new Map<string, TermLayout>()
// Les dossiers qui ont été des projets ouverts dans cette fenêtre. Un dossier
// qui en était un et qui ne l'est plus a été FERMÉ : ses shells sont partis
// avec lui (Workspace.closeProject), sa disposition ne doit pas revenir.
const projetsConnus = new Set<string>()
// Les reprises en vol, par dossier : deux passages de rendu (StrictMode) ou un
// basculement aller-retour rapide ne doivent pas adopter deux fois les mêmes
// shells — un pty branché à deux onglets meurt avec le premier qu'on ferme.
const reprisesEnVol = new Set<string>()

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

// Les onglets tels qu'on les voit, et ce qu'on en a dit au processus principal.
// Il garde les shells, pas les onglets : sans cette disposition, les shells
// repris au redémarrage revenaient chacun dans son onglet, même ceux qu'on
// avait côte à côte. Envoyée quand elle change — un onglet, un split, ou un
// shell qui reçoit son identifiant.
let groupesVus: Groups = []
let dispositionEnvoyee = ""
function envoyerDisposition(): void {
  const layout = groupesVus
    .map((g) => g.map((k) => readStatus(k).ptyId).filter((id): id is string => Boolean(id)))
    .filter((g) => g.length > 0)
  // Rien à ordonner : pendant un changement de projet, la liste est vide un
  // instant, et l'envoyer effacerait la disposition qu'on s'apprête à relire.
  if (layout.length === 0) return
  const texte = JSON.stringify(layout)
  if (texte === dispositionEnvoyee) return
  dispositionEnvoyee = texte
  void window.zyvro.terminal.layout(layout).catch(() => undefined)
}

function patchStatus(key: string, patch: Partial<SessionStatus>): void {
  statuses.set(key, { ...readStatus(key), ...patch })
  if ("ptyId" in patch) window.queueMicrotask(envoyerDisposition)
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
// Le dernier terminal qui a eu le focus : celui que « Clear Terminal » vise
// depuis le menu ou la palette, comme VS Code vise le terminal actif.
let dernierTerminal: Terminal | null = null

/** Effacer le terminal actif, défilement compris. */
export function clearActiveTerminal(): void {
  dernierTerminal?.clear()
}

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

  // Les chemins de fichiers aussi : une erreur de compilation ou une trace de
  // pile s'ouvre dans l'éditeur, à la ligne dite, d'un clic — comme dans VS
  // Code. Seulement ce qui désigne un vrai fichier du projet (`shared/termlinks`).
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const root = useWorkspace.getState().project?.project
      const ligne = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ""
      if (!root || !ligne) return callback(undefined)
      const trouves = findPathLinks(ligne)
        .map((l) => ({ l, rel: toProjectPath(l.path, root, window.zyvro.platform) }))
        .filter((x): x is { l: PathLink; rel: string } => x.rel !== null)
      if (trouves.length === 0) return callback(undefined)
      void window.zyvro.files.exist(trouves.map((x) => x.rel)).then(
        (existe) =>
          callback(
            trouves
              .filter((_, i) => existe[i])
              .map(({ l, rel }) => ({
                // xterm compte ses colonnes à partir de 1, fin incluse.
                range: { start: { x: l.start + 1, y }, end: { x: l.end, y } },
                text: ligne.slice(l.start, l.end),
                decorations: { pointerCursor: true, underline: true },
                activate: () => {
                  useWorkspace.getState().openFile(rel)
                  if (l.line !== null) {
                    revealAt({ path: rel, line: l.line - 1, column: Math.max(0, (l.column ?? 1) - 1), length: 0 })
                  }
                },
              }))
          ),
        () => callback(undefined)
      )
    },
  })

  term.attachCustomKeyEventHandler((event) => {
    if (!estEffacement(event, window.zyvro.platform)) return true
    event.preventDefault()
    term.clear()
    return false
  })

  term.open(node)
  if (hasSize(node)) fitAddon.fit()
  dernierTerminal = term
  term.textarea?.addEventListener("focus", () => {
    dernierTerminal = term
  })

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
  const harnais = readStatus(key).harnais
  const installation = readStatus(key).installation
  const connexion = readStatus(key).connexion
  const ouvrir = dejaLa
    ? Promise.resolve({ id: dejaLa, pty: readStatus(key).pty, banner: undefined, reprise: true })
    : connexion !== undefined
      ? window.zyvro.agent.loginShell(connexion, term.cols, term.rows).then((session) => ({ ...session, reprise: false }))
    : installation !== undefined
      ? // npm qui installe un harnais : l'onglet se termine avec lui, et ce
        // qu'il a dit reste à l'écran.
        window.zyvro.agent
          .installShell(installation, term.cols, term.rows)
          .then((session) => ({ ...session, reprise: false }))
    : harnais !== undefined
      ? // Un harnais dans son interface à lui. Un shell ordinaire à tout point
        // de vue — fermer l'onglet le tue, son défilement est gardé — sauf
        // qu'il ne démarre pas sur une invite.
        window.zyvro.agent
          .shell(harnais.nom, harnais.model, term.cols, term.rows, harnais.conversation ?? null)
          .then((session) => ({ ...session, reprise: false }))
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
          .create(term.cols, term.rows)
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
    if (dernierTerminal === term) dernierTerminal = null
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
  const ouverts = useWorkspace((state) => state.projects)
  // Le dossier dont la disposition est à l'écran. Un état, et plus une variable
  // de module : en développement, React rend deux fois et jette le premier
  // passage. Le repère de module était marqué « fait » par le passage jeté, la
  // disposition ne basculait jamais, et les shells de deux projets se
  // retrouvaient dans les mêmes onglets — le même pty attaché deux fois.
  const [lie, setLie] = useState<string | null>(null)
  const groupsRef = useRef<Groups>([])

  // Les onglets, chacun un groupe de shells côte à côte (shared/termgroups).
  // Ceux du projet ACTIF seulement : les autres restent dans
  // `layoutsByProject`, leurs composants montés mais cachés.
  const [groups, setGroups] = useState<Groups>([])
  const sessions = groups.flat()
  groupsRef.current = groups

  // Les projets fermés : on les reconnaît à ce qu'ils étaient ouverts et ne le
  // sont plus. Leur disposition rangée est jetée — ses shells sont morts avec
  // le projet — et leurs statuts oubliés après le rendu.
  for (const p of ouverts) projetsConnus.add(p.project)
  const estFerme = (dir: string): boolean => projetsConnus.has(dir) && !ouverts.some((p) => p.project === dir)
  for (const [dir, layout] of [...layoutsByProject]) {
    if (!estFerme(dir)) continue
    layoutsByProject.delete(dir)
    const keys = layout.groups.flat()
    window.queueMicrotask(() => keys.forEach(forgetStatus))
  }
  if (groups !== groupesVus) {
    groupesVus = groups
    window.queueMicrotask(envoyerDisposition)
  }
  // La part de largeur de chaque shell dans son onglet (1 par défaut) : la
  // séparation se tire, comme dans VS Code.
  const [poids, setPoids] = useState<Record<string, number>>({})
  const zone = useRef<HTMLDivElement | null>(null)
  const [activeKey, setActiveKey] = useState("")

  // Ce que l'arbre nous remet : « ouvrir dans le terminal », c'est un `cd` écrit
  // dans le shell actif.
  //
  // Écrit, et pas exécuté à sa place : la ligne arrive avec son retour à la
  // ligne parce que c'est ce qu'on demande — mais elle arrive dans le shell de
  // quelqu'un, qui la voit, qui a son historique, et qui peut remonter dessus.
  // Un `cd` est ce qu'il y a de plus inoffensif à envoyer ainsi ; rien d'autre
  // ne passe par ce canal.
  // L'onglet actif, lisible depuis un rappel différé : la ligne remise au
  // terminal attend parfois que son shell existe.
  const actifRef = useRef(activeKey)
  actifRef.current = activeKey
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
      if (!ligne) return
      // Le terminal vient peut-être de s'ouvrir pour recevoir cette ligne — un
      // agent qu'on ouvre dans le terminal, un `cd` depuis l'arbre alors qu'il
      // était replié — et son shell n'existe pas encore. La ligne attend qu'il
      // naisse, quelques secondes au plus ; avant, elle était jetée, et le
      // bouton semblait ne rien faire.
      let essais = 0
      const ecrire = (): void => {
        const ptyId = readStatus(actifRef.current).ptyId
        if (ptyId) {
          void window.zyvro.terminal.write(ptyId, ligne)
          return
        }
        if (++essais < 50) setTimeout(ecrire, 100)
      }
      ecrire()
    })
  }

  // Ajuster l'état pendant le rendu, pas dans un effet. Un pty a le cwd de sa
  // naissance : chaque shell appartient à exactement un projet. Basculer de
  // projet RANGE la disposition du sortant et RESTAURE celle de l'entrant —
  // sans démonter les composants xterm des autres projets, dont la fermeture
  // appelle `terminal.dispose` et tue le pty.
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
  // `lie`, sinon le retour du chemin passerait pour un changement de
  // projet et les remplacerait quand même.
  //
  // Depuis le multi-projet, un changement de projet n'est plus « jeter et
  // reprendre » : c'est « ranger et restaurer ». Les shells du sortant
  // tournent toujours ; leurs onglets reviennent tels quels au basculement
  // suivant. `reprendre` ne sert qu'à la première arrivée sur un projet (ou
  // après un rechargement du rendu, quand les clés de session ont disparu).
  if (projectDir !== null && projectDir !== lie) {
    const sortant = lie
    // Ranger la disposition du sortant — pas ses statuts : les ptys vivent, et
    // `patchStatus` les a déjà liés. Les oublier ici ferait un shell de plus à
    // chaque retour. Sauf s'il vient d'être FERMÉ : ses shells sont partis
    // avec lui, et ranger ses onglets les ferait revenir, morts, à la
    // réouverture.
    if (sortant !== null) {
      if (estFerme(sortant)) {
        const keys = groups.flat()
        window.queueMicrotask(() => keys.forEach(forgetStatus))
      } else {
        layoutsByProject.set(sortant, { groups, activeKey, poids })
      }
    }
    const range = projectDir !== null ? layoutsByProject.get(projectDir) : undefined
    setLie(projectDir)
    if (range) {
      // Restaurer : les clés de session existent encore, leurs composants
      // sont montés (cachés), il n'y a qu'à les remontrer.
      setGroups(range.groups)
      setActiveKey(range.activeKey)
      setPoids(range.poids)
    } else {
      // Première arrivée sur ce projet : demander au principal s'il lui reste
      // des shells (rechargement du rendu), ou n'en ouvrir qu'un.
      setGroups([])
      setActiveKey("")
      setPoids({})
      window.queueMicrotask(() => void reprendre(projectDir))
    }
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
  const poser = (keys: string[], tabs: (number | undefined)[]): void => {
    setGroups((actuels) => withRestored(actuels, keys, tabs))
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
  //
  // Seulement les shells encore vivants (rechargement du rendu) : un projet
  // qu'on rouvre n'en recrée aucun, et une session persistante reste dans la
  // liste latérale — l'ouvrir à la place de la personne contredirait ce qu'elle
  // y voit.
  const reprendre = async (dir: string): Promise<void> => {
    if (reprisesEnVol.has(dir)) return
    reprisesEnVol.add(dir)
    let vivants: Awaited<ReturnType<typeof window.zyvro.terminal.running>> = []
    try {
      vivants = await window.zyvro.terminal.running().catch(() => [])
    } finally {
      reprisesEnVol.delete(dir)
    }
    // Le dossier a pu changer pendant l'aller-retour. Adopter les shells d'un
    // dossier qu'on ne regarde plus donnerait des invites qui mentent sur
    // l'endroit où l'on se trouve. Le dossier de travail, pas le projet : sans
    // projet, c'est celui d'accueil.
    if (useWorkspace.getState().root !== dir) return
    // Déjà là : une reprise précédente les a posés.
    if (groupsRef.current.flat().some((key) => vivants.some((v) => v.id === readStatus(key).ptyId))) return
    // Des clés existent déjà pour ce projet (un basculement pendant l'attente,
    // un `poser` arrivé plus tôt) : ne pas les écraser par une seconde liste.
    if (layoutsByProject.has(dir) && layoutsByProject.get(dir)!.groups.flat().length > 0) return
    if (vivants.length === 0) return
    const keys = vivants.map((vivant) => {
      const key = nextSessionKey()
      // L'étiquette suit : un onglet repris doit garder son nom de session,
      // pas redevenir « Shell 2 ».
      patchStatus(key, { ptyId: vivant.id, pty: vivant.pty, persistent: vivant.label })
      return key
    })
    poser(
      keys,
      vivants.map((vivant) => vivant.tab)
    )
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
      const ordre = takeOpen()
      if (ordre === null) return
      // Une session persistante déjà ouverte ici : aller à son onglet plutôt
      // que d'attacher un second client à la même session.
      if (ordre.sorte === "persistante" && ordre.label) {
        const deja = groupsRef.current.flat().find((k) => readStatus(k).persistent === ordre.label)
        if (deja) {
          activate(deja)
          return
        }
      }
      const key = nextSessionKey()
      patchStatus(
        key,
        ordre.sorte === "persistante"
          ? { persistent: ordre.label }
          : ordre.sorte === "connexion"
            ? { connexion: ordre.harnais }
          : ordre.sorte === "installation"
            ? { installation: ordre.harnais }
            : { harnais: { nom: ordre.harnais, model: ordre.model, conversation: ordre.conversation } }
      )
      setGroups((actuels) => addGroup(actuels, key))
      setActiveKey(key)
    })
  }

  // Un onglet montre tout son groupe : chaque shell se réajuste quand il
  // redevient visible.
  const ajuster = (keys: string[], focus: string): void => {
    requestAnimationFrame(() => {
      for (const k of keys) handles.get(k)?.fit()
      handles.get(focus)?.focus()
    })
  }

  const activate = (key: string): void => {
    setActiveKey(key)
    // The wrapper is unhidden in this commit, so the fit has to wait for the
    // browser to give the node a size again.
    ajuster(groupOf(groups, key) ?? [key], key)
  }

  const addSession = (): void => {
    const key = nextSessionKey()
    setGroups((current) => addGroup(current, key))
    setActiveKey(key)
  }

  // Split Terminal : un shell de plus à droite de celui qu'on regarde, dans le
  // même onglet, comme VS Code. Les voisins se réajustent à leur nouvelle
  // largeur d'eux-mêmes (ResizeObserver).
  const splitSession = (): void => {
    const key = nextSessionKey()
    const actif = actifRef.current
    setGroups((current) => (actif ? splitBeside(current, actif, key) : addGroup(current, key)))
    setActiveKey(key)
    requestAnimationFrame(() => handles.get(key)?.focus())
  }
  const demandeSplit = useSyncExternalStore(subscribeSplit, splitToken, () => 0)
  const vueSplit = useRef(demandeSplit)
  if (demandeSplit !== vueSplit.current) {
    vueSplit.current = demandeSplit
    // Après le rendu, comme les autres demandes ; le repère est déjà posé, un
    // second passage de rendu n'en remet pas une en file.
    window.queueMicrotask(splitSession)
  }

  const closeSession = (key: string): void => {
    // Fermé à la main : le principal l'oublie aussi dans ce qu'il rouvrira.
    // Démonter l'onglet appelle ensuite `dispose`, sans effet sur un shell déjà
    // parti — et c'est `dispose` seul qui sert quand on change de projet.
    const ptyId = readStatus(key).ptyId
    if (ptyId) void window.zyvro.terminal.close(ptyId)
    setGroups((current) => {
      if (!groupOf(current, key)) return current
      const { groups: next, fallback } = removeKey(current, key)
      if (key === activeKey) {
        setActiveKey(fallback)
        if (fallback) ajuster(groupOf(next, fallback) ?? [fallback], fallback)
      }
      return next
    })
    forgetStatus(key)
  }

  // Toutes les clés de session de tous les projets : celles du projet actif
  // (dans `groups`) et celles des autres (dans `layoutsByProject`), qui
  // doivent rester montées pour ne pas tuer leurs ptys.
  const allMountedKeys = (() => {
    const out = new Set<string>(sessions)
    for (const layout of layoutsByProject.values()) {
      for (const key of layout.groups.flat()) out.add(key)
    }
    return [...out]
  })()

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
    <div className="flex h-full flex-col bg-background" data-terminal-panel>
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.06] px-1.5">
        {groups.map((group, index) => {
          const isActive = group.includes(activeKey)
          // Un onglet partagé porte le nom de chacun de ses shells, comme VS
          // Code : « Shell 1, Shell 3 ».
          const noms = group.map((key) => nomOnglet(key, sessions.indexOf(key)))
          const nom = noms.join(", ")
          const principal = group.includes(activeKey) ? activeKey : group[0]
          return (
            <div
              key={group[0]}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors",
                isActive
                  ? "bg-white/[0.06] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
              )}
            >
              <button
                type="button"
                onClick={() => activate(principal)}
                className="inline-flex items-center gap-1.5"
                title={nom}
                data-terminal-tab={index}
              >
                {group.length > 1 ? <Columns2 className="h-3 w-3" /> : <TerminalSquare className="h-3 w-3" />}
                {nom}
              </button>
              {/* Fermer l'onglet ferme le shell qu'on y regarde ; les autres
                  restent, comme la poubelle d'un panneau partagé de VS Code. */}
              <button
                type="button"
                onClick={() => closeSession(principal)}
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
        <button
          type="button"
          onClick={splitSession}
          title="Split Terminal"
          disabled={sessions.length === 0}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40"
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>

        {/* Poussé à droite par son propre `ml-auto` : les onglets défilent, et
            un séparateur élastique entre eux et lui se ferait écraser. */}
        <ShellPicker />
      </div>

      {/* Every session stays mounted. Hiding the wrapper (never the xterm host
          itself) keeps the instance, its pty and its scrollback alive. */}
      <div ref={zone} className="relative min-h-0 flex-1">
        {/* Un onglet, ses shells côte à côte. Chaque shell reste un enfant
            direct, sous sa propre clé, et se place par sa part de largeur :
            l'emboîter dans un conteneur de groupe le démonterait — son pty
            avec — dès que ce groupe change de forme (son premier shell fermé,
            un voisin ajouté). */}
        {allMountedKeys.map((key) => {
          const group = groupOf(groups, key) ?? [key]
          const i = group.indexOf(key)
          const n = group.length
          const inProject = sessions.includes(key)
          const visible = inProject && group.includes(activeKey)
          const { left, width } = placeIn(group.map((k) => poids[k] ?? 1), i)
          return (
            <div
              key={key}
              className={cn(
                "absolute inset-y-0",
                !visible && "hidden",
                i > 0 && inProject && "border-l border-white/[0.08]",
                // Le shell qui a la main, quand il y en a plusieurs.
                n > 1 && key === activeKey && "shadow-[inset_0_1px_0_0_rgb(56_189_248/0.6)]"
              )}
              style={inProject ? { left: `${left * 100}%`, width: `${width * 100}%` } : { left: 0, width: "100%" }}
              onMouseDownCapture={() => {
                if (inProject && key !== activeKey) setActiveKey(key)
              }}
            >
              <TerminalSession sessionKey={key} active={visible} />
            </div>
          )
        })}
        {/* Les séparations de l'onglet visible, entre deux shells voisins. */}
        {(groupOf(groups, activeKey) ?? []).slice(1).map((droite, j) => {
          const group = groupOf(groups, activeKey) ?? []
          const gauche = group[j]
          const { left } = placeIn(group.map((k) => poids[k] ?? 1), j + 1)
          return (
            <div
              key={`sep-${droite}`}
              className="absolute inset-y-0 z-10 w-1 -translate-x-1/2 cursor-col-resize hover:bg-sky-400/40"
              style={{ left: `${left * 100}%` }}
              onPointerDown={(event) => {
                const largeur = zone.current?.getBoundingClientRect().width ?? 0
                if (!largeur) return
                event.currentTarget.setPointerCapture(event.pointerId)
                const depart = event.clientX
                const poidsDepart = group.map((k) => poids[k] ?? 1)
                const total = poidsDepart.reduce((a, b) => a + b, 0)
                const bouger = (e: PointerEvent) => {
                  const next = resizePair(poidsDepart, j, ((e.clientX - depart) / largeur) * total, total * 0.1)
                  setPoids((p) => ({ ...p, [gauche]: next[j], [droite]: next[j + 1] }))
                }
                const lacher = () => {
                  window.removeEventListener("pointermove", bouger)
                  window.removeEventListener("pointerup", lacher)
                }
                window.addEventListener("pointermove", bouger)
                window.addEventListener("pointerup", lacher)
              }}
            />
          )
        })}
        {allMountedKeys.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No shell open.
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default TerminalPanel
