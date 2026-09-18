// Les shells qui survivent à l'application.
//
// Le tampon rend le défilement d'un shell fermé ; il ne ressuscite pas ce qui
// tournait dedans — mesuré : fermer la fenêtre tue l'arbre entier, `npm run
// dev` compris. Pour qu'un programme continue quand Zyvro s'en va, il faut
// qu'il ne soit pas notre enfant. C'est exactement le métier de `tmux` et de
// `screen` : la session appartient à un démon à eux, et nous n'en sommes que le
// client.
//
// Demandé par Jeremy — « un second mode pour ouvrir des shells persistants » —
// puis précisé : « c'est même pas tmux, c'est screen le vrai besoin, attach /
// detach, les noms ». Les deux font la même chose ici, donc on prend celui qui
// est là plutôt que d'en imposer un : le choix du binaire n'a aucune raison de
// remonter dans l'interface.
//
// **POSIX seulement, et dit comme tel.** Ni `tmux` ni `screen` ni `dtach` ni
// `abduco` n'ont de portage natif sur Windows. La section ne s'y affiche pas —
// mieux vaut une fonction absente qu'une fonction qui ment.
//
// Ce qui a été mesuré avant d'être écrit, sur le `screen` d'Apple (4.00.03,
// 2006, le plus vieux qu'on rencontrera) :
//
//   · `screen -ls` liste « <pid>.<nom>\t(Detached) », et rend « No Sockets
//     found » quand il n'y a rien ;
//   · `screen -S <nom> -D -RR` attache, et **crée** si la session n'existe pas ;
//   · attacher depuis un pty marche, ce qu'on y tape arrive bien dans la
//     session ;
//   · et surtout : **tuer le client d'attachement laisse la session vivante**,
//     en « Detached ». C'est toute la propriété qu'on cherche — fermer l'onglet
//     ou la fenêtre détache au lieu de tuer.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"

export type Manager = "tmux" | "screen"

/** Une session persistante, telle qu'on la montre. */
export type PersistentShell = {
  /** Le nom réel, celui que le gestionnaire connaît. */
  name: string
  /** Ce qu'on affiche : la part choisie par la personne. */
  label: string
  /** Vrai quand quelqu'un y est déjà attaché — une autre fenêtre, un terminal. */
  attached: boolean
}

function has(bin: string): boolean {
  try {
    execFileSync("/usr/bin/which", [bin], { encoding: "utf8", timeout: 2000 })
    return true
  } catch {
    return false
  }
}

let cached: Manager | null | undefined

/**
 * Le gestionnaire disponible, ou null.
 *
 * `tmux` d'abord : il est plus récent, mieux tenu, et son format de liste est
 * fait pour être analysé. `screen` ensuite parce qu'il est livré avec macOS et
 * la plupart des Unix — c'est celui qu'on trouvera sans rien installer.
 *
 * Mis en cache : la réponse ne change pas dans la vie d'un processus, et
 * chercher un binaire à chaque affichage de panneau serait un appel système par
 * clignement.
 */
export function manager(): Manager | null {
  if (cached !== undefined) return cached
  if (process.platform === "win32") {
    cached = null
    return cached
  }
  cached = has("tmux") ? "tmux" : has("screen") ? "screen" : null
  return cached
}

// Le préfixe qui rend une session reconnaissable comme la nôtre, et propre à ce
// projet. Haché comme les autres identifiants de dossier ici : un chemin n'est
// pas un nom, il a des séparateurs et une longueur qu'un nom de session n'a pas.
function prefixFor(projectDir: string): string {
  const key = createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 8)
  return `zyvro-${key}-`
}

/**
 * Le nom réel d'une session, à partir de ce que la personne a tapé.
 *
 * Réduit à ce qu'un gestionnaire accepte : `screen` coupe sur un point — c'est
 * son séparateur avec le pid — et `tmux` refuse le point aussi. Le reste est
 * mis au propre pour que le nom reste lisible dans un `screen -ls` tapé à la
 * main, ce qui est la moitié de l'intérêt d'avoir des noms.
 */
export function nameFor(projectDir: string, label: string): string {
  const propre =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "shell"
  return `${prefixFor(projectDir)}${propre}`
}

/** Ce qu'on affiche d'un nom réel : la part choisie. */
export function labelOf(projectDir: string, name: string): string {
  const prefix = prefixFor(projectDir)
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * Les sessions de ce projet.
 *
 * Filtrées sur le préfixe : les sessions personnelles de quelqu'un n'ont rien à
 * faire dans ce panneau, et une session d'un autre projet y donnerait une
 * invite qui ment sur l'endroit où l'on se trouve.
 */
export function list(projectDir: string): PersistentShell[] {
  const which = manager()
  if (!which) return []
  const prefix = prefixFor(projectDir)
  const brut = which === "tmux" ? listTmux() : listScreen()
  return brut
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => ({ ...entry, label: labelOf(projectDir, entry.name) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function listTmux(): { name: string; label: string; attached: boolean }[] {
  try {
    // Un format explicite plutôt que la sortie par défaut : elle est faite pour
    // être lue par quelqu'un, et change de forme selon la version.
    const sortie = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_attached}"], {
      encoding: "utf8",
      timeout: 3000,
    })
    return sortie
      .split("\n")
      .map((ligne) => ligne.trim())
      .filter(Boolean)
      .map((ligne) => {
        const [name, attached] = ligne.split("\t")
        return { name, label: name, attached: attached !== "0" }
      })
  } catch {
    // « no server running » sort en erreur : c'est une liste vide, pas une
    // panne.
    return []
  }
}

function listScreen(): { name: string; label: string; attached: boolean }[] {
  let sortie = ""
  try {
    sortie = execFileSync("screen", ["-ls"], { encoding: "utf8", timeout: 3000 })
  } catch (err) {
    // `screen -ls` sort en code non nul quand il n'y a rien à lister, et écrit
    // quand même sa phrase. On lit sa sortie plutôt que son code.
    sortie = String((err as { stdout?: string }).stdout ?? "")
  }
  const lignes = sortie.split("\n")
  const out: { name: string; label: string; attached: boolean }[] = []
  for (const ligne of lignes) {
    // « \t46331.zyvro-ab12cd34-front\t(Detached) » — le pid, un point, le nom.
    const m = /^\s*\d+\.(\S+)\s+\((\w+)\)/.exec(ligne)
    if (!m) continue
    out.push({ name: m[1], label: m[1], attached: /attached/i.test(m[2]) })
  }
  return out
}

/**
 * La commande qui attache — et qui crée si la session n'existe pas.
 *
 * Un seul geste pour les deux cas, volontairement : « ouvrir » ne doit pas
 * demander à quelqu'un de savoir si la session existe déjà. Les deux
 * gestionnaires savent le faire en une commande, et c'est vérifié sur les deux
 * formes.
 */
export function attachCommand(projectDir: string, name: string): { file: string; args: string[] } | null {
  const which = manager()
  if (!which) return null
  if (which === "tmux") {
    // `-A` : attacher si elle existe, créer sinon. `-c` fixe le dossier de la
    // session créée ; pour une session existante il est ignoré, ce qui est
    // juste — elle a son dossier.
    return { file: "tmux", args: ["new-session", "-A", "-s", name, "-c", projectDir] }
  }
  // `-D -RR` : « attache ici et maintenant, quoi qu'il en coûte » — détache un
  // autre client s'il y en a un, et crée si rien n'existe. Le dossier vient du
  // pty qu'on lance dedans.
  return { file: "screen", args: ["-S", name, "-D", "-RR"] }
}

/**
 * Tuer une session pour de bon.
 *
 * Distinct de fermer l'onglet, qui détache. Une session persistante qu'on ne
 * peut pas arrêter depuis l'application est une session qu'on oublie et qui
 * tourne des semaines.
 */
export function kill(name: string): void {
  const which = manager()
  if (!which) return
  try {
    if (which === "tmux") execFileSync("tmux", ["kill-session", "-t", name], { timeout: 3000 })
    else execFileSync("screen", ["-S", name, "-X", "quit"], { timeout: 3000 })
  } catch {
    // Une session déjà partie est le résultat qu'on voulait.
  }
}
