import { spawn as spawnPipe, type ChildProcess } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { shellMcp, type McpTarget } from "./mcp"
import { inLayoutOrder } from "../shared/termgroups"
import { command as shellCommand } from "./shell"

// The integrated shell is not a convenience feature. `claude` and `codex` both
// change behaviour when stdout is not a terminal, and the whole point of the
// desktop app is that the user drives those tools. So we want a real PTY, and
// we only fall back to pipes when the native module is unavailable.

type PtyLike = {
  /** Le processus du shell. Zéro quand on ne l'a pas — le repli par `script`
   *  lance un intermédiaire, et c'est son pid qu'on aurait, pas celui du
   *  shell. */
  pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number) => void): void
}

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }
  ): {
    /** Le processus du shell, que node-pty expose. C'est lui qu'on interroge
     *  pour savoir dans quel dossier quelqu'un s'est déplacé. */
    readonly pid: number
    write(d: string): void
    resize(c: number, r: number): void
    kill(): void
    onData(cb: (d: string) => void): void
    onExit(cb: (e: { exitCode: number }) => void): void
  }
}

let ptyModule: NodePtyModule | null | undefined

// loadPty resolves node-pty lazily and remembers the failure. A native module
// built for the wrong Electron ABI throws on require, and that must degrade the
// terminal rather than prevent the app from opening at all.
function loadPty(): NodePtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyModule = require("node-pty") as NodePtyModule
  } catch (err) {
    console.warn("node-pty unavailable, terminal runs in pipe mode:", (err as Error).message)
    ptyModule = null
  }
  return ptyModule
}

export function ptyAvailable(): boolean {
  return loadPty() !== null
}

// Le shell du panneau vit dans shell.ts : c'est un choix de la personne, pas un
// détail du pty. `$SHELL` reste le défaut, mais il n'est plus le seul mot.
/**
 * Ce qu'un pty lance à la place du shell de connexion.
 *
 * Deux choses s'en servent : la commande qui attache une session persistante,
 * et le harnais qu'on ouvre dans son interface à lui depuis le panneau de
 * l'agent. `env` est ce que la seconde a apporté — voir makePty.
 */
export type Command = { file: string; args: string[]; env?: Record<string, string> }

// `script -c` prend UNE chaîne que /bin/sh redécoupe : des arguments recollés par des espaces
// perdaient leurs espaces, leurs guillemets, leurs parenthèses — un prompt d'agent, un nom
// de modèle, tout ce qui n'est pas un mot simple. Chacun est donc cité.
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

function defaultShell(): { file: string; args: string[] } {
  return shellCommand()
}

function makePty(
  cwd: string,
  cols: number,
  rows: number,
  extra: Record<string, string | undefined> = {},
  command: Command | null = null
): PtyLike {
  const mod = loadPty()
  const { file, args } = command ?? defaultShell()
  // L'environnement de la commande en dernier : c'est le plus précis des trois.
  //
  // Il existe pour ce qu'un harnais lancé à la main doit savoir et qui ne peut
  // pas passer par ses arguments — l'adresse et le jeton de la passerelle, la
  // clef d'un fournisseur. Une clef sur la ligne de commande se lit dans `ps`,
  // pour tout ce qui tourne sur la machine ; c'est la règle de ce dépôt depuis
  // que la question de l'agent part sur stdin, et elle vaut ici aussi.
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...extra, ...command?.env }

  if (mod) {
    const proc = mod.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env })
    // Un pty dont le processus vient de mourir lève sur `write`, `resize` et `kill`
    // (EIO, EBADF, « already exited ») : la fenêtre n'a pas encore appris la fin, elle
    // écrit ou redimensionne un shell qui n'est plus là, et l'exception partait dans le
    // processus principal. Rien à faire d'une écriture dans le vide.
    const quiet = (what: string, run: () => void): void => {
      try {
        run()
      } catch (err) {
        console.warn(`[pty] ${what} on a finished shell: ${(err as Error).message}`)
      }
    }
    return {
      pid: proc.pid,
      write: (d) => quiet("write", () => proc.write(d)),
      resize: (c, r) => quiet("resize", () => proc.resize(c, r)),
      kill: () => quiet("kill", () => proc.kill()),
      onData: (cb) => proc.onData((d) => quiet("data", () => cb(d))),
      onExit: (cb) => proc.onExit((e) => quiet("exit", () => cb(e.exitCode))),
    }
  }

  // Fallback. `script` is a system utility that allocates a real PTY and runs
  // the shell inside it, so `claude` and `codex` still see a terminal and keep
  // their interactive behaviour. What it cannot do is propagate a resize, so
  // the window size is fixed for the life of the session. Windows has no
  // equivalent, and there the shell genuinely runs on pipes.
  const useScript = process.platform !== "win32"
  const lance = useScript ? "/usr/bin/script" : file
  const commandArgs = useScript
    ? process.platform === "darwin"
      ? ["-q", "/dev/null", file, ...args]
      : ["-qfc", [file, ...args].map(shellQuote).join(" "), "/dev/null"]
    : args

  const child: ChildProcess = spawnPipe(lance, commandArgs, {
    cwd,
    env: { ...env, LINES: String(rows), COLUMNS: String(cols) },
  })
  // Sans écouteur, un événement `error` fait tomber le processus principal : le
  // programme introuvable (ENOENT) et l'écriture dans un tuyau fermé (EPIPE) le sont
  // tous deux. L'un est une fin avec le code 127, l'autre un écho dans le vide.
  let spawnFailure: string | null = null
  child.on("error", (err) => {
    spawnFailure = err.message
  })
  child.stdin?.on("error", () => undefined)
  child.stdout?.on("error", () => undefined)
  child.stderr?.on("error", () => undefined)
  return {
    // Le repli lance `/usr/bin/script`, pas le shell : son pid ne dirait pas où
    // le shell se trouve. Mieux vaut zéro que le mauvais dossier.
    pid: 0,
    write: (d) => {
      if (child.stdin?.writable) child.stdin.write(d)
    },
    resize: () => undefined,
    kill: () => {
      try {
        child.kill()
      } catch {
        // Déjà parti.
      }
    },
    onData: (cb) => {
      // Un caractère de plusieurs octets peut arriver coupé entre deux morceaux : un
      // décodeur à état, par flux, plutôt que `toString` morceau par morceau.
      for (const stream of [child.stdout, child.stderr]) {
        const decoder = new StringDecoder("utf8")
        stream?.on("data", (b: Buffer) => {
          const text = decoder.write(b)
          if (text) cb(text)
        })
      }
    },
    onExit: (cb) => {
      let done = false
      const end = (code: number): void => {
        if (done) return
        done = true
        cb(code)
      }
      child.on("exit", (code) => end(code ?? 0))
      child.on("error", () => {
        if (spawnFailure !== null) end(127)
      })
    },
  }
}

// Envoyer à la fenêtre sans jamais lever. `isDestroyed()` ne suffit pas : le cadre peut
// être libéré entre le test et l'envoi (« Render frame was disposed »), et l'exception
// tombait alors dans un rappel de pty — donc dans le processus principal.
function sendSafe(target: WebContents, channel: string, payload: unknown): void {
  try {
    if (!target.isDestroyed()) target.send(channel, payload)
  } catch {
    // La fenêtre s'en va ; ce qu'elle n'a pas reçu ne lui sert plus.
  }
}

// Les morceaux qu'un shell écrit sont regroupés quelques millisecondes avant de
// partir : une interface d'agent qui redessine son écran en envoie une centaine par
// seconde, un message IPC chacun. Au-delà de la taille, on envoie sans attendre.
const BATCH_MS = 4
const BATCH_MAX = 128 * 1024

type Session = {
  id: string
  pty: PtyLike
  dispose?: () => void
  /** Le dossier où ce shell est né. Un pty ne change jamais de cwd : c'est ce
   *  qui dit à quel projet il appartient, et donc qui a le droit de le
   *  reprendre. */
  cwd: string
  /**
   * Vrai quand ce shell n'est que le client d'une session persistante.
   *
   * Il ne faut alors PAS garder son défilement à la fermeture : la session
   * survit chez `tmux` ou `screen`, avec son propre historique, et la rouvrir
   * la réattache. Sans cette distinction, la réouverture recréait un shell
   * ordinaire affichant l'ancien défilement — il avait l'air ouvert, et rien ne
   * tournait dedans. Signalé par Jeremy le 19/09, une heure après la première
   * version : deux fonctions écrites coup sur coup qui se marchaient dessus.
   */
  attached: boolean
  /** L'étiquette de la session persistante, pour que l'onglet garde son nom
   *  après un rechargement. */
  label?: string
  /**
   * Ce que le shell a déjà écrit, pour le rendre à une fenêtre qui s'est
   * rechargée.
   *
   * Sans lui, se raccrocher rendait une invite vivante sous un écran vide :
   * `pty.onData` partait droit vers la fenêtre, et rien n'était gardé.
   */
  seen: string
  /** L'enregistrement de session d'agent que cet onglet incarne, quand c'en est un. */
  agentShell?: string
  /** Ce qui n'avait de sens que pour ce shell : un fichier MCP qui porte un jeton. */
  cleanup?: () => void
  /** Prévenu quand le shell se termine de lui-même, ou qu'on le ferme à la main. */
  onEnd?: (why: "exit" | "closed", code?: number) => void
  /** Vrai dès qu'on a décidé de sa fin : l'arrêt qui suit n'est plus un événement. */
  ending?: boolean
  stopPaste?: () => void
  /** Ce qui a été écrit et n'est pas encore parti vers la fenêtre. */
  pending?: string
  flush?: ReturnType<typeof setTimeout>
}

// Ce qu'on garde de chaque shell. Un demi-mégaoctet : de quoi retrouver
// plusieurs écrans de défilement sans faire grossir le processus principal
// quand une compilation bavarde tourne depuis une heure.
const SHELL_MAX_BYTES = 512 * 1024

// Terminals owns every shell the window opened. It holds the WebContents so it
// can push output, and drops every session when the window goes away: an
// orphaned login shell per closed window would pile up invisibly.
export class Terminals {
  private sessions = new Map<string, Session>()
  // Les onglets du terminal, tels que le rendu les compose : les identifiants
  // de shell, onglet par onglet. Pour les rendre groupés comme on les avait
  // laissés (shared/termgroups, `inLayoutOrder`).
  private layout: string[][] = []

  setLayout(layout: string[][]): void {
    this.layout = layout
  }

  // mcp est le contexte du démon de ce projet, quand il y en a un. Chaque shell
  // ouvert par l'application porte de quoi joindre ses serveurs MCP : ce qu'on
  // lance dedans — un autre agent, un client, un curl — ne peut pas deviner un
  // port et un jeton qui changent à chaque démarrage.
  create(
    target: WebContents,
    cwd: string,
    cols = 80,
    rows = 24,
    mcp: McpTarget | null = null,
    /**
     * Ce qui n'est pas un shell de connexion ordinaire.
     *
     * Deux choses passent par ici : la commande qui attache une session
     * persistante, et le harnais qu'on ouvre dans son interface à lui. Le reste
     * — le pty, le tampon, la reprise — est rigoureusement le même, et c'est
     * voulu : ce sont des shells de plus dans le panneau, pas un second
     * panneau.
     *
     * Un objet plutôt qu'une suite d'arguments : `attached` s'est ajouté le
     * jour où les deux ont cessé de vouloir dire la même chose, et une
     * septième position optionnelle est une position qu'on remplit de travers.
     */
    options: {
      command?: Command | null
      /** L'étiquette de la session, retenue pour la reprise et pour l'onglet. */
      label?: string
      /**
       * Vrai quand ce shell n'est que le client d'une session qui lui survit.
       *
       * Déduit de `command !== null` tant que la commande ne servait qu'à
       * attacher. Ce n'est plus vrai : un harnais lancé dans un shell est une
       * commande aussi, et il n'est le client de rien — fermer son onglet le
       * tue, et son défilement mérite d'être gardé comme celui de n'importe
       * quel shell. Déduire ici aurait fait perdre l'un pour l'autre en
       * silence.
       */
      attached?: boolean
      /**
       * Le défilement d'une session précédente, quand ce shell la remplace.
       *
       * Semé dans ce qu'il a « vu » : sans ça, la prochaine sauvegarde ne
       * retiendrait que ce qu'il a écrit depuis, et l'historique repris
       * disparaîtrait à la deuxième réouverture.
       */
      seed?: string
      /**
       * Pour un agent natif (shared/agentShell) : l'enregistrement qu'il incarne,
       * le nettoyage de ce qu'il a écrit (la configuration MCP porte un jeton),
       * et ce qu'on fait quand il finit. La fin NATURELLE ou la croix de
       * l'onglet préviennent `onEnd` ; l'arrêt de l'application, d'un projet ou
       * d'une page qui se recharge, non — la session reste « ouverte » et se
       * rouvre au prochain démarrage.
       */
      agentShell?: string
      cleanup?: () => void
      onEnd?: (why: "exit" | "closed", code?: number) => void
    } = {}
  ): { id: string; pty: boolean; banner?: string } {
    const { command = null, label, attached = false, seed = "", agentShell, cleanup, onEnd } = options
    const id = randomUUID()
    const wired = mcp ? shellMcp(mcp) : null
    const lieu = cwd || os.homedir()
    const pty = makePty(lieu, cols, rows, wired?.env, command)
    const vu = seed ? `${seed.slice(-SHELL_MAX_BYTES)}\r\n` : ""
    this.sessions.set(id, { id, pty, dispose: wired?.dispose, cwd: lieu, seen: vu, attached, label, agentShell, cleanup, onEnd })

    pty.onData((data) => {
      this.remember(id, data)
      this.queue(id, target, data)
    })
    pty.onExit((code) => {
      // Ce qui reste à dire part AVANT la fin : la fenêtre ne doit pas apprendre qu'un
      // shell est mort avant d'avoir lu sa dernière ligne.
      this.sendPending(id, target)
      const fini = this.drop(id)
      try {
        if (fini && !fini.ending) fini.onEnd?.("exit", code)
      } catch (err) {
        console.warn(`[terminal] onEnd failed: ${(err as Error).message}`)
      }
      sendSafe(target, "terminal:exit", { id, code })
    })

    // Le bandeau revient avec la réponse plutôt qu'en flot de sortie : le rendu
    // l'écrit lui-même avant de vider ce qu'il a mis de côté, et il est donc
    // toujours au-dessus de la première invite, pas au milieu.
    return { id, pty: ptyAvailable(), banner: wired?.banner }
  }

  private queue(id: string, target: WebContents, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.pending = (session.pending ?? "") + data
    if (session.pending.length >= BATCH_MAX) {
      this.sendPending(id, target)
      return
    }
    if (session.flush) return
    session.flush = setTimeout(() => this.sendPending(id, target), BATCH_MS)
  }

  private sendPending(id: string, target: WebContents): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.flush) clearTimeout(session.flush)
    session.flush = undefined
    const data = session.pending
    session.pending = ""
    if (data) sendSafe(target, "terminal:data", { id, data })
  }

  // remember garde ce que le shell a écrit, borné.
  //
  // On jette par le début quand le plafond est atteint, en coupant de
  // préférence à une fin de ligne : un flux de terminal est plein de séquences
  // d'échappement, et couper au milieu de l'une d'elles rendrait un écran
  // bariolé. Couper après un saut de ligne ne garantit rien — une séquence peut
  // enjamber — mais c'est le point le moins mauvais, et le pire des cas est
  // cosmétique sur les premières lignes rejouées.
  private remember(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.seen += data
    if (session.seen.length <= SHELL_MAX_BYTES) return
    const trop = session.seen.length - SHELL_MAX_BYTES
    const saut = session.seen.indexOf("\n", trop)
    session.seen = session.seen.slice(saut === -1 ? trop : saut + 1)
  }

  /**
   * Les shells encore vivants dans ce dossier de projet.
   *
   * Ce que le rendu demande au démarrage. En développement, `electron-vite`
   * recharge la page à chaque fichier sauvé, et les ptys — qui sont des enfants
   * du processus principal — lui survivent : ils continuaient d'écrire dans le
   * vide, injoignables, jusqu'à la fermeture de la fenêtre. Une page neuve
   * ouvrait un shell de plus à côté.
   *
   * Filtré par dossier parce qu'un pty a le cwd de sa naissance : reprendre
   * dans un projet le shell d'un autre donnerait une invite qui ment sur l'endroit
   * où l'on se trouve.
   */
  running(cwd: string): { id: string; pty: boolean; label?: string; tab: number; agentShell?: string }[] {
    const lieu = cwd || os.homedir()
    // Les sessions persistantes y sont aussi : après un rechargement du rendu,
    // leur client d'attachement est bien vivant — il faut le reprendre, sinon
    // il fuit exactement comme un shell ordinaire. Ce qui les distingue est
    // qu'on ne garde PAS leur défilement à la fermeture, pas qu'on les oublie
    // en chemin.
    const ici = [...this.sessions.values()].filter((session) => session.cwd === lieu)
    const parId = new Map(ici.map((session) => [session.id, session]))
    return inLayoutOrder(
      ici.map((session) => session.id),
      this.layout
    ).map(({ id, tab }) => ({
      id,
      pty: ptyAvailable(),
      label: parId.get(id)?.label,
      tab,
      agentShell: parId.get(id)?.agentShell,
    }))
  }

  /**
   * Les étiquettes des sessions persistantes que cette fenêtre tient attachées.
   *
   * Parce que `screen -ls` ment pendant une seconde. Attacher lance un client,
   * et la socket que `screen` crée pour lui n'existe pas encore quand la
   * commande rend la main : une liste demandée dans la foulée revient sans la
   * session qu'on vient d'ouvrir. La version d'avant contournait ça en
   * attendant 1,2 s et en espérant — ce qui tient tant que la machine n'est pas
   * chargée.
   *
   * Or nous n'avons pas à demander à `screen` ce que nous venons de faire
   * nous-mêmes. Ceci est ce que cette fenêtre sait de source sûre ; le
   * gestionnaire reste la source pour tout le reste, c'est-à-dire pour les
   * sessions ouvertes ailleurs.
   */
  attachedLabels(cwd: string): string[] {
    const lieu = cwd || os.homedir()
    return [...this.sessions.values()]
      .filter((session) => session.attached && session.cwd === lieu && Boolean(session.label))
      .map((session) => session.label as string)
  }

  /** Rendre à une fenêtre ce qu'un shell a déjà écrit. */
  replay(id: string, target: WebContents): void {
    const session = this.sessions.get(id)
    if (!session || target.isDestroyed() || session.seen === "") return
    // `seen` contient déjà ce qui attendait d'être envoyé : l'envoyer ensuite le
    // doublerait à l'écran.
    if (session.flush) clearTimeout(session.flush)
    session.flush = undefined
    session.pending = ""
    sendSafe(target, "terminal:data", { id, data: session.seen })
  }

  // drop oublie une session et efface ce qui n'avait de sens que pour elle : le
  // fichier de configuration MCP porte un jeton, et sa durée de vie est celle
  // du shell qui pouvait s'en servir.
  private drop(id: string): Session | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.sessions.delete(id)
    if (session.flush) clearTimeout(session.flush)
    session.stopPaste?.()
    // Le nettoyage d'un shell ne doit jamais empêcher d'en oublier un autre.
    for (const clean of [session.dispose, session.cleanup]) {
      try {
        clean?.()
      } catch (err) {
        console.warn(`[terminal] cleanup failed: ${(err as Error).message}`)
      }
    }
    return session
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(cols, rows)
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (session) session.ending = true
    this.drop(id)?.pty.kill()
  }

  /** Le shell vivant qui incarne cette session d'agent, s'il y en a un. */
  byAgentShell(agentShell: string): string | null {
    for (const session of this.sessions.values()) if (session.agentShell === agentShell) return session.id
    return null
  }

  /**
   * Coller un texte dans l'invite d'un harnais quand il est prêt.
   *
   * Pour les harnais qui ne prennent pas leur tâche en argument. « Prêt » : il
   * a écrit quelque chose, puis s'est tu un moment — l'écran de confiance ou
   * l'invite sont dessinés. Collé entre crochets de collage, SANS retour à la
   * ligne final : le texte arrive dans la boîte de saisie, la personne le relit
   * et valide. Rien n'est jamais envoyé à sa place, surtout pas à un écran qui
   * demande « faites-vous confiance à ce dossier ? ».
   */
  pasteWhenReady(id: string, text: string, quietMs = 1500, giveUpMs = 30_000, submit = false): void {
    const session = this.sessions.get(id)
    if (!session || !text) return
    const started = Date.now()
    let last = session.seen.length
    let still = Date.now()
    let timer: NodeJS.Timeout | null = null
    const tick = (): void => {
      timer = null
      const current = this.sessions.get(id)
      if (!current) return
      if (current.seen.length !== last) {
        last = current.seen.length
        still = Date.now()
      }
      const ready = current.seen.length > 0 && Date.now() - still >= quietMs
      if (ready) {
        current.pty.write(text)
        // Entrée un instant après le collage : l'interface du harnais traite
        // d'abord le texte collé, puis la touche.
        if (submit) {
          const send = setTimeout(() => this.sessions.get(id)?.pty.write("\r"), 400)
          send.unref?.()
        }
        return
      }
      if (Date.now() - started > giveUpMs) return
      timer = setTimeout(tick, 250)
    }
    timer = setTimeout(tick, 250)
    session.stopPaste = () => {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Fermer tous les shells.
   *
   * Le processus meurt avec la fenêtre — mesuré : un `npm run dev` lancé dans
   * un shell est bien tué par ce chemin, avec tout son arbre. Les sessions
   * persistantes, elles, sont détachées : leur défilement est chez `tmux` ou
   * `screen`, et la liste latérale les montre à la prochaine ouverture.
   */
  async disposeAll(cwd?: string): Promise<void> {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }

  /**
   * Fermer les shells d'un seul projet — celui qu'on ferme — en laissant les
   * autres (les projets ouverts à côté dans la même fenêtre) tourner.
   *
   * Les clients de sessions persistantes partent aussi : fermer le projet les
   * détache, et `PersistentList` les remontre. Un onglet qui rouvrirait tout
   * seul contredirait cette liste.
   */
  disposeProject(projectDir: string): void {
    const racine = path.resolve(projectDir)
    const siens = [...this.sessions.values()].filter(
      (session) =>
        session.cwd === racine || session.cwd === projectDir || session.cwd.startsWith(racine + path.sep)
    )
    for (const session of siens) this.dispose(session.id)
  }

  /**
   * Fermer un shell parce qu'on n'en veut plus — la croix de son onglet.
   */
  close(id: string, _projectDir: string | null): void {
    const session = this.sessions.get(id)
    if (session && !session.ending) {
      session.ending = true
      session.onEnd?.("closed")
    }
    this.dispose(id)
  }
}
