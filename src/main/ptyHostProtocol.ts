// Ce que l'application et l'hôte de terminaux (ptyhost.ts) se disent.
//
// Une ligne de JSON par message, sur une socket locale. Volontairement petit et
// stable : après une mise à jour, l'application neuve parle à l'hôte lancé par
// l'ancienne — c'est même toute la raison d'être de l'hôte. Un champ qu'on
// ajoute doit donc rester facultatif des deux côtés, et `v` ne change que si
// l'ancien hôte ne peut vraiment plus être compris.
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const PROTOCOL = 1

export type HostSpawn = {
  t: "spawn"
  key: string
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  cols: number
  rows: number
}

export type ToHost =
  | { t: "hello"; token: string }
  | HostSpawn
  | { t: "attach"; key: string }
  | { t: "detach"; key: string }
  | { t: "write"; key: string; data: string }
  | { t: "resize"; key: string; cols: number; rows: number }
  | { t: "kill"; key: string }
  | { t: "list"; id: number }
  | { t: "gateway"; id: number; key: string; aim: unknown }

export type FromHost =
  | { t: "hello"; v: number; pid: number }
  | { t: "replay"; key: string; data: string }
  | { t: "data"; key: string; data: string }
  | { t: "exit"; key: string; code: number }
  | { t: "gone"; key: string }
  | { t: "list"; id: number; keys: string[]; /** Tués, pas encore morts (absent chez un hôte ancien). */ dying?: string[] }
  | { t: "gateway"; id: number; baseUrl: string; origin: string; token: string }
  | { t: "error"; id?: number; key?: string; message: string }

/** Ce qu'il faut pour joindre l'hôte : écrit par lui, lu par l'application. */
export type HostInfo = { v: number; pid: number; socket: string; token: string }

// Un hôte par version de l'application. Après une mise à jour, l'hôte lancé par
// l'ancienne garde ses agents — c'est le but — mais il tourne depuis l'ancien
// paquet, qu'on vient de remplacer : sous macOS, node-pty lance chaque nouveau
// processus par un utilitaire rangé dans ce paquet. Les agents NEUFS vont donc à
// l'hôte de la version courante ; les anciens restent joignables chez le leur,
// qui s'en va de lui-même quand ils ont fini.
export function versionTag(version: string): string {
  return version.replace(/[^A-Za-z0-9.-]+/g, "_").slice(0, 40) || "dev"
}

/** Le fichier où l'hôte dit où il écoute — dans le dossier de l'application, lisible par la personne seule. */
export function infoFile(dataDir: string, version: string): string {
  return path.join(dataDir, `ptyhost-${versionTag(version)}.json`)
}

/** Les fichiers de tous les hôtes connus, quelle que soit leur version. */
export const INFO_FILE = /^ptyhost-[A-Za-z0-9._-]+\.json$/

/**
 * Où l'hôte écoute.
 *
 * Pas dans le dossier de l'application : sous macOS une socket Unix a un
 * chemin limité à 104 octets, et « ~/Library/Application Support/Zyvro
 * Studio/… » d'une personne au nom long le dépasse. Un nom court, propre au
 * dossier de données (un hôte par installation, dev et prod séparés).
 */
export function socketPath(dataDir: string, version: string, dir = os.tmpdir()): string {
  const key = createHash("sha256").update(`${path.resolve(dataDir)}\0${versionTag(version)}`).digest("hex").slice(0, 12)
  if (process.platform === "win32") return `\\\\.\\pipe\\zyvro-ptyhost-${key}`
  return path.join(dir, `zyvro-pty-${key}.sock`)
}

/**
 * Le dossier de la socket : à la personne seule (0700). Sous Linux, /tmp est
 * partagé, et un nom prévisible pouvait y être pris d'avance par un autre
 * compte — l'hôte croyait alors un des siens déjà là et s'en allait. Un dossier
 * qui n'est pas à nous, ou ouvert aux autres : un dossier neuf, au nom tiré au
 * hasard. L'application ne devine jamais ce chemin, elle le lit dans le
 * fichier d'info de l'hôte.
 */
export function socketDir(): string {
  if (process.platform === "win32") return os.tmpdir()
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  const dir = path.join(os.tmpdir(), `zyvro-${uid}`)
  try {
    mkdirSync(dir, { mode: 0o700 })
  } catch {
    // Déjà là : vérifié juste en dessous.
  }
  try {
    const st = lstatSync(dir)
    if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0) return dir
  } catch {
    // Illisible : le repli.
  }
  return mkdtempSync(path.join(os.tmpdir(), "zyvro-"))
}

/** Découper un flux en lignes de JSON ; une ligne illisible est ignorée, pas fatale. */
export function lineReader<T>(onMessage: (message: T) => void): (chunk: Buffer | string) => void {
  let pending = ""
  return (chunk) => {
    pending += chunk.toString()
    let at = pending.indexOf("\n")
    while (at !== -1) {
      const line = pending.slice(0, at)
      pending = pending.slice(at + 1)
      if (line.trim()) {
        try {
          onMessage(JSON.parse(line) as T)
        } catch {
          // Une ligne coupée ou fausse : la suivante repart propre.
        }
      }
      at = pending.indexOf("\n")
    }
  }
}
