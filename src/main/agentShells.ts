import { createHash } from "node:crypto"
import { existsSync, readdirSync, readSync, openSync, closeSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  codexSessionFromMeta,
  MAX_RECORDS,
  sanitizeRecords,
  sessionIdOk,
  type AgentShellRecord,
} from "../shared/agentShell"

// Les sessions d'agent natif, gardées entre deux lancements de l'application.
//
// Même raison d'être que `conversations.ts`, autre contenu : là on garde ce que
// le panneau a dessiné, ici on garde CE QU'IL FAUT POUR ROUVRIR — l'identifiant
// que le harnais connaît et la configuration avec laquelle il a été lancé. Le
// transcript, lui, appartient à la CLI (`~/.claude/projects`, `~/.codex/sessions`) :
// le recopier serait tenir une seconde version qui diverge.
//
// Un fichier par projet, nommé d'après son chemin haché, à côté du compte plutôt
// que dans le projet : quelles sessions on a eues est un fait sur la personne, et
// un `.zyvro/` qui se remplirait de journaux finirait commité.

export function fileFor(dir: string, projectDir: string): string {
  const key = createHash("sha256").update(path.resolve(projectDir)).digest("hex").slice(0, 16)
  return path.join(dir, `${key}.json`)
}

export async function load(dir: string, projectDir: string): Promise<AgentShellRecord[]> {
  try {
    const raw = await fs.readFile(fileFor(dir, projectDir), "utf8")
    return sanitizeRecords((JSON.parse(raw) as { sessions?: unknown }).sessions)
  } catch {
    // Pas de fichier, fichier illisible, écriture à moitié faite : tous veulent
    // dire « pas d'historique ». Une liste de sessions ne vaut pas qu'on
    // empêche une fenêtre de s'ouvrir.
    return []
  }
}

// Toutes les sessions d'un projet partagent un fichier : on sérialise le cycle
// lecture/modification/écriture entier. Deux agents qui se terminent ensemble
// liraient sinon la même liste, et le dernier à écrire effacerait l'autre.
const writes = new Map<string, Promise<unknown>>()

function serial<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(file) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  writes.set(file, next)
  const clear = (): void => {
    if (writes.get(file) === next) writes.delete(file)
  }
  void next.then(clear, clear)
  return next
}

async function write(file: string, sessions: AgentShellRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Écrit à côté puis renommé : une coupure au milieu laisserait un fichier
  // tronqué, et la relecture suivante rendrait un historique vide.
  const temp = `${file}.partial`
  await fs.writeFile(temp, JSON.stringify({ sessions }, null, 2), "utf8")
  await fs.rename(temp, file)
}

/** Modifier la liste d'un projet d'un seul tenant. */
export function update(
  dir: string,
  projectDir: string,
  change: (all: AgentShellRecord[]) => AgentShellRecord[]
): Promise<AgentShellRecord[]> {
  const file = fileFor(dir, projectDir)
  return serial(file, async () => {
    const all = await load(dir, projectDir)
    const next = sanitizeRecords(change(all)).slice(0, MAX_RECORDS)
    await write(file, next)
    return next
  })
}

export function upsert(dir: string, projectDir: string, record: AgentShellRecord): Promise<AgentShellRecord[]> {
  return update(dir, projectDir, (all) => {
    const stamped = { ...record, updatedAt: new Date().toISOString() }
    const index = all.findIndex((item) => item.id === record.id)
    return index === -1 ? [stamped, ...all] : all.map((item, i) => (i === index ? stamped : item))
  })
}

export function patch(
  dir: string,
  projectDir: string,
  id: string,
  change: Partial<Pick<AgentShellRecord, "name" | "sessionId" | "state" | "model" | "effort" | "prompt">>
): Promise<AgentShellRecord[]> {
  return update(dir, projectDir, (all) =>
    all.map((item) => (item.id === id ? { ...item, ...change, updatedAt: new Date().toISOString() } : item))
  )
}

export function forget(dir: string, projectDir: string, id: string): Promise<AgentShellRecord[]> {
  return update(dir, projectDir, (all) => all.filter((item) => item.id !== id))
}

// ---- retrouver la session d'un harnais ---------------------------------------------------

function configDir(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  return env[variable]?.trim() || path.join(os.homedir(), fallback)
}

/**
 * Le journal d'une session de claude existe-t-il ?
 *
 * Il se range dans `projects/<chemin du dossier aplati>/<id>.jsonl`. La règle
 * d'aplatissement a changé d'une version à l'autre et dépend de la plateforme :
 * on ne la recalcule pas, on cherche l'identifiant dans tous les dossiers.
 *
 * Raison d'être : une session lancée avec `--session-id` mais où rien n'a été
 * envoyé n'a pas de journal, et `claude --resume <id>` répond « No conversation
 * found » et s'en va. Ce cas-là se relance avec `--session-id`.
 */
export function claudeSessionExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!sessionIdOk(id)) return false
  const root = path.join(configDir(env, "CLAUDE_CONFIG_DIR", ".claude"), "projects")
  try {
    return readdirSync(root).some((name) => existsSync(path.join(root, name, `${id}.jsonl`)))
  } catch {
    return false
  }
}

// La première ligne d'un journal de codex porte ses instructions de base : 21 Ko relevés
// sur la 0.163, et c'est elle qui dit l'identifiant et le dossier. Lue par un tampon
// de 16 Ko, elle arrivait coupée, le JSON ne se lisait pas, et la session n'était
// jamais retrouvée — changer de modèle repartait alors d'une session neuve. On lit
// donc jusqu'au saut de ligne, par morceaux, avec un plafond.
const MAX_FIRST_LINE = 2 * 1024 * 1024

function firstLine(file: string): string {
  const fd = openSync(file, "r")
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let text = ""
    let at = 0
    while (text.length < MAX_FIRST_LINE) {
      const n = readSync(fd, chunk, 0, chunk.length, at)
      if (n <= 0) break
      text += chunk.subarray(0, n).toString("utf8")
      at += n
      const end = text.indexOf("\n")
      if (end !== -1) return text.slice(0, end)
    }
    return text
  } finally {
    closeSync(fd)
  }
}

const MAX_DEPTH = 5

function codexRollouts(env: NodeJS.ProcessEnv): { file: string; mtime: number }[] {
  const root = path.join(configDir(env, "CODEX_HOME", ".codex"), "sessions")
  const out: { file: string; mtime: number }[] = []
  const walk = (dir: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(dir, name)
      // Les journaux se rangent par AAAA/MM/JJ, mais cette disposition est celle de
      // codex, pas la nôtre : elle a déjà changé, et un lecteur qui n'accepte les
      // journaux qu'à une profondeur donnée n'en voit plus aucun le jour où elle
      // change — la session semble alors perdue. On prend donc tout journal,
      // à n'importe quel niveau (borné).
      try {
        const info = statSync(full)
        if (info.isDirectory()) {
          if (depth < MAX_DEPTH) walk(full, depth + 1)
        } else if (/^rollout-.*\.jsonl$/.test(name)) {
          out.push({ file: full, mtime: info.mtimeMs })
        }
      } catch {
        // Un fichier qui disparaît pendant qu'on le lit n'est pas une erreur.
      }
    }
  }
  walk(root, 0)
  return out
}

/**
 * La session que codex vient de créer dans ce dossier.
 *
 * Codex choisit lui-même son identifiant ; on le retrouve par le journal qu'il
 * écrit au démarrage. `since` borne la recherche aux journaux apparus après le
 * lancement de l'onglet, `taken` écarte ceux que d'autres onglets ont déjà
 * revendiqués — deux codex lancés ensemble dans le même dossier ne doivent pas
 * se voler leur session.
 */
export function findCodexSession(
  cwd: string,
  since: number,
  taken: ReadonlySet<string> = new Set(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const candidates = codexRollouts(env)
    .filter((c) => c.mtime >= since - 2000)
    .sort((a, b) => a.mtime - b.mtime)
  for (const { file } of candidates) {
    try {
      const id = codexSessionFromMeta(firstLine(file), cwd)
      if (id && !taken.has(id)) return id
    } catch {
      // Un journal à moitié écrit : le prochain passage le relira.
    }
  }
  return null
}

/** Le journal de cette session de codex existe-t-il ? */
export function codexSessionExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return sessionIdOk(id) && codexRollouts(env).some((c) => c.file.includes(id))
}

/**
 * Attendre que codex dise quelle est sa session, puis la rapporter.
 *
 * Un sondage borné : le journal apparaît au premier tour de parole, parfois
 * longtemps après le lancement (la personne lit l'écran de confiance avant de
 * poser sa première question). Il s'arrête au bout de dix minutes, ou quand on
 * l'annule — fermeture de l'onglet.
 */
export function watchCodexSession(
  cwd: string,
  since: number,
  taken: () => ReadonlySet<string>,
  found: (id: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  every = 2000,
  limit = 10 * 60_000
): () => void {
  const started = Date.now()
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  const tick = (): void => {
    timer = null
    if (stopped) return
    const id = findCodexSession(cwd, since, taken(), env)
    if (id) {
      stopped = true
      found(id)
      return
    }
    if (Date.now() - started > limit) return
    timer = setTimeout(tick, every)
    timer.unref?.()
  }
  timer = setTimeout(tick, every)
  timer.unref?.()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

// ---- lire le transcript d'une session (pour changer de harnais) ----------------------------

const MAX_TRANSCRIPT = 4 * 1024 * 1024

function readTail(file: string): string {
  const size = statSync(file).size
  const fd = openSync(file, "r")
  try {
    // Les derniers mégaoctets : c'est la fin du fil qu'on veut, et un journal de
    // plusieurs jours ne doit pas être lu en entier pour un briefing de douze mille caractères.
    const length = Math.min(size, MAX_TRANSCRIPT)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    // Coupé au milieu d'une ligne : on écarte la première.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text
  } finally {
    closeSync(fd)
  }
}

/** Le journal de cette session, quand on sait le lire (claude, codex), sinon null. */
export function readTranscript(kind: string, id: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!sessionIdOk(id)) return null
  try {
    if (kind === "claude") {
      const root = path.join(configDir(env, "CLAUDE_CONFIG_DIR", ".claude"), "projects")
      for (const name of readdirSync(root)) {
        const file = path.join(root, name, `${id}.jsonl`)
        if (existsSync(file)) return readTail(file)
      }
      return null
    }
    if (kind === "codex") {
      const found = codexRollouts(env).find((c) => c.file.includes(id))
      return found ? readTail(found.file) : null
    }
  } catch {
    return null
  }
  return null
}
