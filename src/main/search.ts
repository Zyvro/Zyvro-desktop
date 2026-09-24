import fs from "node:fs/promises"
import path from "node:path"
import { HIDDEN, resolveInside } from "./files"

// Chercher dans le projet, et remplacer.
//
// C'est la fonction qu'on ouvre dix fois par jour dans un éditeur et qu'on ne
// remarque que le jour où elle manque. Elle a deux moitiés qui ne se
// ressemblent pas :
//
//   · **Chercher** est sans conséquence. On peut se tromper, recommencer,
//     élargir. Le seul risque est de faire attendre : un dossier de projet
//     contient `node_modules`, et une recherche qui le traverse rend la main
//     une minute plus tard.
//
//   · **Remplacer** écrit dans des fichiers qu'on n'a pas ouverts. Là, le
//     risque est de remplacer autre chose que ce qu'on a vu : le fichier a
//     changé depuis la recherche, les décalages ne valent plus rien, et la
//     ligne d'à côté y passe. D'où la vérification avant chaque écriture — on
//     ne remplace un passage que s'il est encore exactement celui qu'on a
//     montré.

export type SearchQuery = {
  query: string
  /** « Aa » : sans ça, on cherche sans distinguer les majuscules. */
  matchCase?: boolean
  /** « ab » : le mot entier, pas un morceau d'un autre mot. */
  wholeWord?: boolean
  /** « .* » : le texte tapé est une expression régulière. */
  regex?: boolean
  /** Des motifs séparés par des virgules : `*.ts, src/**`. Vide = tout. */
  include?: string
  exclude?: string
  /**
   * Le dossier où chercher, relatif à la racine. Vide = le projet entier.
   *
   * Une portée, et pas un motif d'inclusion de plus : « chercher dans ce
   * dossier » désigne un chemin littéral, et le faire passer par `include`
   * casse sur le nom que personne ne teste. Un dossier nommé « Notes, old »
   * donne deux motifs — `Notes` et `old/**` — qui cherchent ailleurs sans rien
   * dire ; un nom qui contient `*` ou `?` en ratisse plus large.
   *
   * Elle est aussi le point de départ du parcours plutôt qu'un filtre posé
   * après : chercher dans `src/` ne traverse pas `node_modules` pour le
   * rejeter ensuite.
   */
  scope?: string
}

export type Match = {
  line: number
  /** En unités de code UTF-16, comme le fait un éditeur. Base 0. */
  column: number
  length: number
  /** La ligne entière, pour l'afficher. Tronquée : une ligne minifiée fait un mégaoctet. */
  text: string
}

export type FileHits = { path: string; matches: Match[] }

export type SearchResult = {
  files: FileHits[]
  matches: number
  /** Vrai quand on s'est arrêté avant la fin : la liste n'est pas la vérité. */
  truncated: boolean
}

// Les limites. Elles ne sont pas là pour économiser la machine mais pour que le
// panneau reste utilisable : au-delà, personne ne lit la liste, on reformule la
// recherche.
const MAX_MATCHES = 2000
const MAX_PER_FILE = 200
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINE = 400

export class BadPattern extends Error {}

/** Une portée qui n'est pas un dossier où l'on peut chercher. */
export class BadScope extends Error {}

// normalizeScope réduit la portée à ce que le parcours sait manger : un chemin
// relatif, sans barre de tête ni de queue. « . » et « / » veulent dire le
// projet entier, comme une portée absente.
export function normalizeScope(scope: string | undefined): string {
  const propre = (scope ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "")
  return propre === "." ? "" : propre
}

// matcherFor traduit ce que la barre de recherche propose en une expression.
//
// Sortie et exportée parce que c'est là que se jouent les trois boutons : une
// recherche sans `i` qui devrait l'avoir ne trouve rien, et un `\b` oublié
// trouve « import » dans « important ».
export function matcherFor(query: SearchQuery): RegExp {
  const raw = query.query
  if (raw === "") throw new BadPattern("Type something to search for.")

  let source = query.regex ? raw : raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (query.wholeWord) {
    // \b ne veut rien dire contre un motif qui commence par autre chose qu'un
    // caractère de mot — `\b(` ne trouverait jamais rien — donc on ne l'ajoute
    // que là où il a un sens.
    const wordish = /^[\w$]/.test(query.regex ? raw.replace(/^\\[bB]/, "") : raw)
    if (wordish) source = `\\b${source}\\b`
  }
  try {
    return new RegExp(source, query.matchCase ? "g" : "gi")
  } catch (err) {
    throw new BadPattern(`That is not a valid regular expression: ${(err as Error).message}`)
  }
}

// globToRegExp : les motifs d'inclusion, dans la forme qu'un éditeur emploie.
//
// `*.ts` par nom de fichier, `src/**` par chemin. Un motif sans barre oblique
// ne parle que du nom : taper `*.ts` et ne rien trouver parce que le fichier
// est dans un sous-dossier serait un piège.
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim()
  let body = ""
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "*") {
      if (trimmed[i + 1] === "*") {
        i++
        if (trimmed[i + 1] === "/") {
          // `src/**/x` doit aussi trouver `src/x` : le dossier intermédiaire
          // est facultatif, sinon le motif que tout le monde écrit rate le cas
          // le plus simple.
          i++
          body += "(?:.*/)?"
        } else {
          body += ".*"
        }
      } else {
        body += "[^/]*"
      }
    } else if (ch === "?") {
      body += "[^/]"
    } else if (".+^${}()|[]\\".includes(ch)) {
      body += `\\${ch}`
    } else {
      body += ch
    }
  }
  // Un motif sans barre oblique ne parle que du nom du fichier : taper `*.ts`
  // et ne rien trouver parce que le fichier est dans un sous-dossier serait un
  // piège.
  const anchored = trimmed.includes("/") ? `^${body}$` : `(?:^|/)${body}$`
  return new RegExp(anchored, "i")
}

function listOf(patterns: string | undefined): RegExp[] {
  return (patterns ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp)
}

function wanted(relative: string, include: RegExp[], exclude: RegExp[]): boolean {
  if (exclude.some((r) => r.test(relative))) return false
  return include.length === 0 || include.some((r) => r.test(relative))
}

// looksBinary : un fichier qui contient un octet nul n'est pas du texte.
//
// C'est la même règle que git, et elle suffit : sans elle, une recherche rend
// des « lignes » de trois mille caractères illisibles prises dans une image.
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, 8192)
  for (let i = 0; i < end; i++) if (buffer[i] === 0) return true
  return false
}

async function* walk(root: string, relative = ""): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
  } catch {
    // Un dossier devenu illisible entre deux frappes n'arrête pas la recherche.
    return
  }
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) yield* walk(root, child)
    else if (entry.isFile()) yield child
  }
}

// listFiles : tous les fichiers du projet, pour Quick Open (⌘P).
//
// Le même parcours que la recherche, donc les mêmes dossiers cachés : un
// `node_modules` n'a rien à faire dans une liste qu'on filtre au clavier. Borné,
// parce qu'un dépôt géant ne doit pas geler la fenêtre le temps de tout lire ;
// au-delà, on le dit plutôt que de laisser croire que la liste est complète.
export const LIST_LIMIT = 50_000

export async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const rootReal = await fs.realpath(root)
  const files: string[] = []
  for await (const file of walk(rootReal)) {
    if (files.length >= LIST_LIMIT) return { files, truncated: true }
    files.push(file)
  }
  return { files, truncated: false }
}

// scopeStart : d'où part le parcours, vérifié avant de partir.
//
// Le portail habituel, parce qu'une portée vient du rendu comme le reste. Et
// une portée qui n'est pas un dossier lisible est dite, pas avalée : sans ça
// elle rend zéro résultat, ce qui se lit « le texte n'y est pas » — le plus
// trompeur des deux silences.
async function scopeStart(root: string, asked: string | undefined): Promise<string> {
  const scope = normalizeScope(asked)
  if (!scope) return ""
  const full = await resolveInside(root, scope)
  try {
    const info = await fs.stat(full)
    if (!info.isDirectory()) throw new BadScope(`${scope} is a file, not a folder to search in.`)
  } catch (err) {
    if (err instanceof BadScope) throw err
    throw new BadScope(`There is no folder named ${scope} to search in.`)
  }
  return scope
}

export async function search(root: string, query: SearchQuery): Promise<SearchResult> {
  const matcher = matcherFor(query)
  const include = listOf(query.include)
  const exclude = listOf(query.exclude)
  const scope = await scopeStart(root, query.scope)

  const files: FileHits[] = []
  let matches = 0
  let truncated = false

  for await (const relative of walk(root, scope)) {
    if (matches >= MAX_MATCHES) {
      truncated = true
      break
    }
    if (!wanted(relative, include, exclude)) continue

    const full = path.join(root, relative)
    let buffer: Buffer
    try {
      const info = await fs.stat(full)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
      buffer = await fs.readFile(full)
    } catch {
      continue
    }
    if (looksBinary(buffer)) continue

    const hits: Match[] = []
    const lines = buffer.toString("utf8").split("\n")
    for (let i = 0; i < lines.length && hits.length < MAX_PER_FILE; i++) {
      const line = lines[i].replace(/\r$/, "")
      matcher.lastIndex = 0
      for (let found = matcher.exec(line); found; found = matcher.exec(line)) {
        hits.push({
          line: i,
          column: found.index,
          length: found[0].length,
          text: line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line,
        })
        // Un motif qui accepte le vide — `a*` — boucle sans ça, indéfiniment,
        // sur la même position.
        if (found[0] === "") matcher.lastIndex++
        if (hits.length >= MAX_PER_FILE) break
      }
    }
    if (hits.length === 0) continue
    files.push({ path: relative, matches: hits })
    matches += hits.length
  }

  return { files, matches, truncated }
}

export type ReplaceTarget = { path: string; line: number; column: number; length: number }

export type ReplaceResult = {
  files: number
  matches: number
  /** Des passages qui n'étaient plus ceux qu'on avait montrés. */
  skipped: number
}

// replaceAll remplace partout où la recherche trouve.
//
// `targets` restreint à des passages précis — c'est le « remplacer celui-ci »,
// une occurrence à la fois. Sans lui, tout ce que la recherche trouve y passe.
export async function replaceAll(
  root: string,
  query: SearchQuery,
  replacement: string,
  targets?: ReplaceTarget[]
): Promise<ReplaceResult> {
  const matcher = matcherFor(query)
  const chosen = new Map<string, ReplaceTarget[]>()
  if (targets) {
    for (const target of targets) {
      chosen.set(target.path, [...(chosen.get(target.path) ?? []), target])
    }
  }

  const found = targets ? [...chosen.keys()] : (await search(root, query)).files.map((f) => f.path)

  let files = 0
  let matches = 0
  let skipped = 0

  for (const relative of found) {
    // Le même portail que partout ailleurs : un chemin qui sort du projet est
    // refusé avant d'être ouvert, même quand il vient de notre propre
    // recherche.
    const full = await resolveInside(root, relative)
    let text: string
    try {
      text = await fs.readFile(full, "utf8")
    } catch {
      skipped += chosen.get(relative)?.length ?? 1
      continue
    }

    const lines = text.split("\n")
    let touched = 0

    const wanted = chosen.get(relative)
    if (wanted) {
      // De la fin vers le début : remplacer par l'avant décale tout ce qui
      // suit, et les colonnes qu'on tient ne vaudraient plus rien.
      for (const target of [...wanted].sort((a, b) => b.line - a.line || b.column - a.column)) {
        const line = lines[target.line]
        if (line === undefined) {
          skipped++
          continue
        }
        const bare = line.replace(/\r$/, "")
        matcher.lastIndex = target.column
        const found = matcher.exec(bare)
        // Toujours le même passage, au même endroit, de la même longueur ?
        // Sinon le fichier a changé depuis qu'on l'a montré, et ce qu'on
        // écrirait ne serait pas ce qu'on a vu.
        if (!found || found.index !== target.column || found[0].length !== target.length) {
          skipped++
          continue
        }
        const carriage = line.endsWith("\r") ? "\r" : ""
        lines[target.line] =
          bare.slice(0, target.column) + expand(found, replacement, query) + bare.slice(target.column + target.length) + carriage
        touched++
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        const carriage = lines[i].endsWith("\r") ? "\r" : ""
        const bare = lines[i].replace(/\r$/, "")
        matcher.lastIndex = 0
        if (!matcher.test(bare)) continue
        matcher.lastIndex = 0
        let count = 0
        const next = bare.replace(matcher, (...args) => {
          count++
          return expand(args as unknown as RegExpExecArray, replacement, query)
        })
        lines[i] = next + carriage
        touched += count
      }
    }

    if (touched === 0) continue
    await fs.writeFile(full, lines.join("\n"), "utf8")
    files++
    matches += touched
  }

  return { files, matches, skipped }
}

// expand : ce que vaut le texte de remplacement.
//
// En mode expression régulière, `$1` désigne un groupe — c'est la moitié de
// l'intérêt du mode. En mode ordinaire, `$1` est deux caractères qu'on a tapés
// et qui doivent ressortir tels quels : un remplacement littéral qui se met à
// interpréter des dollars est une surprise qu'on découvre après coup.
function expand(found: RegExpExecArray, replacement: string, query: SearchQuery): string {
  if (!query.regex) return replacement
  return replacement.replace(/\$(\d{1,2}|&|\$)/g, (whole, token: string) => {
    if (token === "$") return "$"
    if (token === "&") return found[0]
    const group = found[Number(token)]
    return group === undefined ? whole : group
  })
}
