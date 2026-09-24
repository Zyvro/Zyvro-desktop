import { execFileSync, spawn as spawnPipe, type ChildProcess } from "node:child_process"
import { mkdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { app } from "electron"
import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { shellMcp, type McpTarget } from "./mcp"
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
function defaultShell(): { file: string; args: string[] } {
  return shellCommand()
}

function makePty(
  cwd: string,
  cols: number,
  rows: number,
  extra: Record<string, string | undefined> = {},
  command: { file: string; args: string[] } | null = null
): PtyLike {
  const mod = loadPty()
  const { file, args } = command ?? defaultShell()
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...extra }

  if (mod) {
    const proc = mod.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env })
    return {
      pid: proc.pid,
      write: (d) => proc.write(d),
      resize: (c, r) => proc.resize(c, r),
      kill: () => proc.kill(),
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit((e) => cb(e.exitCode)),
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
      : ["-qfc", [file, ...args].join(" "), "/dev/null"]
    : args

  const child: ChildProcess = spawnPipe(lance, commandArgs, {
    cwd,
    env: { ...env, LINES: String(rows), COLUMNS: String(cols) },
  })
  return {
    // Le repli lance `/usr/bin/script`, pas le shell : son pid ne dirait pas où
    // le shell se trouve. Mieux vaut zéro que le mauvais dossier.
    pid: 0,
    write: (d) => child.stdin?.write(d),
    resize: () => undefined,
    kill: () => child.kill(),
    onData: (cb) => {
      child.stdout?.on("data", (b: Buffer) => cb(b.toString("utf8")))
      child.stderr?.on("data", (b: Buffer) => cb(b.toString("utf8")))
    },
    onExit: (cb) => child.on("exit", (code) => cb(code ?? 0)),
  }
}

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
    // Ce qu'on lance à la place du shell de connexion : la commande qui attache
    // une session persistante. Le reste — le pty, le tampon, la reprise — est
    // rigoureusement le même, et c'est voulu : une session persistante est un
    // shell de plus dans le panneau, pas un second panneau.
    command: { file: string; args: string[] } | null = null,
    /** L'étiquette d'une session persistante, retenue pour la reprise. */
    label?: string,
    /**
     * Le défilement d'une session précédente, quand ce shell la remplace.
     *
     * Semé dans ce qu'il a « vu » : sans ça, la prochaine sauvegarde ne
     * retiendrait que ce qu'il a écrit depuis, et l'historique repris
     * disparaîtrait à la deuxième réouverture.
     */
    seed = ""
  ): { id: string; pty: boolean; banner?: string } {
    const id = randomUUID()
    const wired = mcp ? shellMcp(mcp) : null
    const lieu = cwd || os.homedir()
    const pty = makePty(lieu, cols, rows, wired?.env, command)
    const vu = seed ? `${seed.slice(-SHELL_MAX_BYTES)}\r\n` : ""
    this.sessions.set(id, { id, pty, dispose: wired?.dispose, cwd: lieu, seen: vu, attached: command !== null, label })

    pty.onData((data) => {
      this.remember(id, data)
      if (target.isDestroyed()) return
      target.send("terminal:data", { id, data })
    })
    pty.onExit((code) => {
      this.drop(id)
      if (target.isDestroyed()) return
      target.send("terminal:exit", { id, code })
    })

    // Le bandeau revient avec la réponse plutôt qu'en flot de sortie : le rendu
    // l'écrit lui-même avant de vider ce qu'il a mis de côté, et il est donc
    // toujours au-dessus de la première invite, pas au milieu.
    return { id, pty: ptyAvailable(), banner: wired?.banner }
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
  running(cwd: string): { id: string; pty: boolean; label?: string }[] {
    const lieu = cwd || os.homedir()
    // Les sessions persistantes y sont aussi : après un rechargement du rendu,
    // leur client d'attachement est bien vivant — il faut le reprendre, sinon
    // il fuit exactement comme un shell ordinaire. Ce qui les distingue est
    // qu'on ne garde PAS leur défilement à la fermeture, pas qu'on les oublie
    // en chemin.
    return [...this.sessions.values()]
      .filter((session) => session.cwd === lieu)
      .map((session) => ({ id: session.id, pty: ptyAvailable(), label: session.label }))
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
    target.send("terminal:data", { id, data: session.seen })
  }

  // drop oublie une session et efface ce qui n'avait de sens que pour elle : le
  // fichier de configuration MCP porte un jeton, et sa durée de vie est celle
  // du shell qui pouvait s'en servir.
  private drop(id: string): Session | null {
    const session = this.sessions.get(id)
    if (!session) return null
    this.sessions.delete(id)
    session.dispose?.()
    return session
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(cols, rows)
  }

  dispose(id: string): void {
    this.drop(id)?.pty.kill()
  }

  /**
   * Fermer tous les shells, et garder ce qu'ils ont dit.
   *
   * Le processus meurt avec la fenêtre — mesuré : un `npm run dev` lancé dans
   * un shell est bien tué par ce chemin, avec tout son arbre. Ce qui peut
   * survivre, c'est le défilement, et c'est ce que Jeremy a demandé : « on
   * rouvre le projet, bam, on a toujours nos shells, avec nos programmes tués
   * mais au moins une partie de l'historique ».
   *
   * Écrit ici et pas dans `dispose` : fermer un onglet de shell à la main est
   * un geste qui dit « je n'en veux plus », alors que fermer la fenêtre dit
   * « à tout à l'heure ».
   */
  async disposeAll(cwd?: string): Promise<void> {
    const vivants = [...this.sessions.values()]
    // Synchrone : à ⌘Q, `before-quit` n'attend pas une promesse, et
    // l'application sortait avant que l'écriture asynchrone ait eu lieu. Le
    // fichier gardait alors les shells de la fois d'avant — y compris ceux
    // qu'on avait fermés — et ils revenaient à la réouverture.
    //
    // Et seulement s'il reste des shells : à la fermeture, `disposeAll` passe
    // deux fois — `before-quit`, puis la fenêtre qui se ferme — et le second
    // passage, qui ne trouve plus rien, écrasait la sauvegarde du premier par
    // une liste vide. Un fichier qui doit devenir vide l'est déjà : fermer le
    // dernier shell à la main l'a réécrit (`close`).
    if (cwd && vivants.length > 0) this.keepHistory(cwd, vivants)
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }

  // ---- l'historique qui survit à la fermeture ------------------------------

  // Où ce shell se trouve maintenant.
  //
  // Un pty naît avec un cwd, mais quelqu'un tape `cd` — et c'est même le geste
  // le plus courant. Rouvrir le projet dans le dossier de départ pendant que le
  // défilement montre du travail fait ailleurs, c'est un écran qui ment.
  // Signalé par Jeremy dix minutes après la première version.
  //
  // Lu au système, parce que rien dans le shell ne nous le dit : `/proc` sur
  // Linux, `lsof` sur macOS — vérifié qu'il rend bien le dossier et qu'il suit
  // les `cd`. Windows n'a ni l'un ni l'autre et gardera son dossier de départ ;
  // c'est moins bien, et c'est dit plutôt que caché.
  private cwdOf(pid: number): string | null {
    if (!pid) return null
    try {
      if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`)
      if (process.platform !== "darwin") return null
      const sortie = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        timeout: 2000,
      })
      const ligne = sortie.split("\n").find((l) => l.startsWith("n"))
      return ligne ? ligne.slice(1) : null
    } catch {
      // Un dossier qu'on ne sait pas lire n'empêche pas de fermer la fenêtre.
      return null
    }
  }

  private historyFile(projectDir: string): string {
    // Haché comme les conversations, et pour les mêmes raisons : un chemin
    // n'est pas un nom de fichier — il a des séparateurs, il peut être plus
    // long qu'un nom ne peut l'être, et macOS normalise certains caractères
    // derrière votre dos.
    const key = createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 16)
    return path.join(app.getPath("userData"), "shells", `${key}.json`)
  }

  /**
   * Fermer un shell parce qu'on n'en veut plus — la croix de son onglet — et
   * le retirer de ce qu'on rouvrira.
   *
   * Sans ça le fichier gardait le shell fermé : replier puis rouvrir le
   * terminal relisait ce fichier, et le shell qu'on venait de fermer revenait.
   * Distinct de `dispose`, qui sert aussi quand un onglet disparaît parce
   * qu'on change de projet : là, rien n'a été refusé, et réécrire le fichier
   * effacerait l'historique qu'on veut retrouver.
   */
  close(id: string, projectDir: string | null): void {
    this.dispose(id)
    if (projectDir) this.keepHistory(projectDir, [...this.sessions.values()])
  }

  private keepHistory(projectDir: string, sessions: Session[]): void {
    const racine = path.resolve(projectDir)
    const shells = sessions.filter(
      (session) =>
        // Pas les sessions persistantes : leur défilement est chez `screen` ou
        // `tmux`, et le garder ici en ferait un second, plus vieux, affiché
        // dans un shell mort qu'on croirait vivant.
        //
        // Et tout shell du projet, sous-dossier compris : un shell rouvert dans
        // `server/` n'était pas retenu, puisque son dossier n'était pas
        // exactement la racine.
        !session.attached &&
        (session.cwd === racine || session.cwd === projectDir || session.cwd.startsWith(racine + path.sep))
    )
    try {
      const file = this.historyFile(projectDir)
      mkdirSync(path.dirname(file), { recursive: true })
      // Un fichier temporaire puis un renommage : une fenêtre qui se ferme
      // pendant l'écriture laisserait sinon un JSON tronqué, et la réouverture
      // suivante perdrait tout l'historique au lieu d'en perdre la fin.
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(
        temp,
        JSON.stringify({
          shells: shells.map((session) => ({ seen: session.seen, cwd: this.cwdOf(session.pty.pid) ?? session.cwd })),
        }),
        "utf8"
      )
      renameSync(temp, file)
    } catch {
      // Un historique qu'on ne sait pas écrire n'est pas une raison de refuser
      // de fermer la fenêtre.
    }
  }

  /**
   * Ce que les shells de ce projet avaient écrit la dernière fois.
   *
   * Un tableau, un élément par shell ouvert alors : la réouverture en refait
   * autant, chacun avec son défilement au-dessus d'une invite neuve. Les
   * programmes, eux, sont morts avec la fenêtre — on ne fait pas semblant du
   * contraire.
   */
  async saved(projectDir: string): Promise<{ seen: string; cwd: string }[]> {
    try {
      const raw = await fs.readFile(this.historyFile(projectDir), "utf8")
      const parsed = JSON.parse(raw) as { shells?: unknown }
      if (!Array.isArray(parsed.shells)) return []
      const out: { seen: string; cwd: string }[] = []
      for (const brut of parsed.shells) {
        // La première version n'écrivait que le texte. Un fichier de ce
        // matin-là ne doit pas faire perdre son historique à quelqu'un.
        if (typeof brut === "string") {
          out.push({ seen: brut, cwd: projectDir })
          continue
        }
        const forme = (brut && typeof brut === "object" ? brut : {}) as Record<string, unknown>
        if (typeof forme.seen !== "string") continue
        out.push({ seen: forme.seen, cwd: typeof forme.cwd === "string" ? forme.cwd : projectDir })
      }
      return out
    } catch {
      return []
    }
  }
}
