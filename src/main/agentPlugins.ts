import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  allowedPluginPath,
  PLUGIN_LIMITS,
  PLUGIN_NAME,
  validatePluginFiles,
  type PluginFile,
  type PluginPackage,
  type PluginSkill,
} from "../shared/pluginPackage"

// Les plugins d'agent en paquets (shared/pluginPackage), sur le disque.
//
// Trois endroits, du plus général au plus particulier :
//
//   · `bundled`   — livrés avec l'app (resources/plugins), comme Plugin Creator ;
//   · `installed` — venus de la boutique, dans userData/agent-plugins, pour
//                   toute l'app comme les réglages ;
//   · `project`   — en cours d'écriture, dans <projet>/.zyvro/plugins. C'est là
//                   que l'agent les crée, et ils se chargent tels quels : on voit
//                   le plugin pendant qu'on l'écrit, puis on le publie.
//
// Un même nom à deux endroits : le plus particulier gagne, et l'autre est dit
// masqué plutôt que de disparaître sans explication. C'est ce qui permet de
// travailler sur la version suivante d'un plugin qu'on a installé.
//
// Aucun import d'Electron : les chemins arrivent en paramètres, pour que
// `scripts/check-plugin-package.mjs` exerce ce fichier tel quel.

export type PluginOrigin = "bundled" | "installed" | "project"
export type PluginRoot = { origin: PluginOrigin; dir: string }

export type LoadedPlugin = Omit<PluginPackage, "skills"> & {
  origin: PluginOrigin
  dir: string
  /** Chaque skill, avec son chemin absolu sur ce poste. */
  skills: (PluginSkill & { file: string })[]
  /** Les autres endroits où ce nom existe aussi, et qui ne sont pas chargés. */
  shadows: PluginOrigin[]
}

/** Un dossier qui n'est pas un plugin valable : montré, pas tu. */
export type PluginProblem = { origin: PluginOrigin; name: string; dir: string; error: string }

export type PluginList = { plugins: LoadedPlugin[]; problems: PluginProblem[] }

const ORDER: PluginOrigin[] = ["project", "installed", "bundled"]

// pluginDigest reproduit l'empreinte du serveur octet pour octet. Même grammaire
// que celle des packs (main/store.ts, packDigest), autre préfixe, pour qu'un
// plugin et un pack ne puissent jamais partager une empreinte :
//
//   preimage = "zyvro-plugin-digest-v1" LF field(name) field(version) count file*
//   file     = field(path) field(contents)
//   field(x) = decimal(byte-length of x) LF x LF
//
// Fichiers triés par chemin, comparés en octets.
export function pluginDigest(name: string, version: string, files: PluginFile[]): string {
  const field = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8")
    return Buffer.concat([Buffer.from(`${bytes.length}\n`, "ascii"), bytes, Buffer.from("\n", "ascii")])
  }
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")))
  const parts: Buffer[] = [Buffer.from("zyvro-plugin-digest-v1\n", "ascii"), field(name), field(version), Buffer.from(`${sorted.length}\n`, "ascii")]
  for (const file of sorted) parts.push(field(file.path), field(file.code))
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex")
}

// readPluginDir lit les fichiers d'un plugin, et seulement ceux que la
// grammaire permet. Un fichier en trop est une erreur plutôt qu'un oubli : il
// ne partirait pas à la publication, et le plugin publié ne serait pas celui
// qu'on a essayé. Les fichiers cachés (.DS_Store) sont ignorés, et un lien
// symbolique est refusé — un paquet qui pointerait ailleurs sur le disque
// publierait des fichiers que personne n'a mis dedans.
export async function readPluginDir(dir: string): Promise<PluginFile[]> {
  const files: PluginFile[] = []
  const walk = async (relative: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`"${rel}" is a symbolic link, which a plugin cannot contain.`)
      if (entry.isDirectory()) {
        // skills/ puis skills/<nom>/ : rien de plus profond n'est permis.
        if (depth >= 2 || (depth === 0 && entry.name !== "skills")) throw new Error(`"${rel}/" is not allowed in a plugin.`)
        await walk(rel, depth + 1)
        continue
      }
      if (!entry.isFile() || !allowedPluginPath(rel)) {
        throw new Error(`"${rel}" is not allowed in a plugin: only zyvro-plugin.json, README.md and skills/<name>/<file>.md.`)
      }
      if (files.length >= PLUGIN_LIMITS.files) throw new Error(`More than ${PLUGIN_LIMITS.files} files.`)
      const raw = await fs.readFile(path.join(dir, rel))
      if (raw.length > PLUGIN_LIMITS.fileBytes) throw new Error(`"${rel}" is ${raw.length} bytes, over the limit of ${PLUGIN_LIMITS.fileBytes}.`)
      let code: string
      try {
        code = new TextDecoder("utf-8", { fatal: true }).decode(raw)
      } catch {
        throw new Error(`"${rel}" is not UTF-8 text.`)
      }
      files.push({ path: rel, code })
    }
  }
  await walk("", 0)
  return files
}

/** Lire et valider un plugin : le paquet, ses fichiers, et le dossier. */
export async function loadPluginDir(dir: string): Promise<{ pkg: PluginPackage; files: PluginFile[] }> {
  const files = await readPluginDir(dir)
  const pkg = validatePluginFiles(files)
  // Le dossier porte le nom : c'est ce qui rend « installé » et « masqué »
  // vérifiables sans ouvrir chaque manifeste.
  if (pkg.name !== path.basename(dir)) throw new Error(`The manifest names "${pkg.name}" but the folder is "${path.basename(dir)}".`)
  return { pkg, files }
}

export async function listAgentPlugins(roots: PluginRoot[]): Promise<PluginList> {
  const found = new Map<string, LoadedPlugin>()
  const problems: PluginProblem[] = []
  const ordered = [...roots].sort((a, b) => ORDER.indexOf(a.origin) - ORDER.indexOf(b.origin))
  for (const root of ordered) {
    const entries = await fs.readdir(root.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Un téléchargement interrompu (.install-…) ou un fichier perdu là n'est
      // pas un plugin, et ne mérite pas d'être signalé comme un plugin cassé.
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const dir = path.join(root.dir, entry.name)
      const already = found.get(entry.name)
      if (already) {
        already.shadows.push(root.origin)
        continue
      }
      try {
        const { pkg } = await loadPluginDir(dir)
        found.set(pkg.name, {
          ...pkg,
          origin: root.origin,
          dir,
          skills: pkg.skills.map((s) => ({ ...s, file: path.join(dir, ...s.path.split("/")) })),
          shadows: [],
        })
      } catch (error) {
        problems.push({ origin: root.origin, name: entry.name, dir, error: (error as Error).message })
      }
    }
  }
  return { plugins: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), problems }
}

// writePluginFiles installe un paquet déjà validé, d'un coup : écrit à côté,
// puis renommé à la place de l'ancien. Un plugin à moitié écrit serait chargé
// tel quel au prochain tour, avec la moitié de ses skills.
export async function writePluginFiles(installRoot: string, name: string, files: PluginFile[]): Promise<string> {
  if (!PLUGIN_NAME.test(name)) throw new Error(`"${name}" is not a valid plugin name.`)
  for (const file of files) {
    if (!allowedPluginPath(file.path)) throw new Error(`Refused to write "${file.path}".`)
  }
  await fs.mkdir(installRoot, { recursive: true })
  const target = path.join(installRoot, name)
  const temporary = path.join(installRoot, `.install-${randomUUID()}`)
  const previous = path.join(installRoot, `.previous-${randomUUID()}`)
  try {
    for (const file of files) {
      const out = path.join(temporary, ...file.path.split("/"))
      await fs.mkdir(path.dirname(out), { recursive: true })
      await fs.writeFile(out, file.code, "utf8")
    }
    const had = await fs.stat(target).then(() => true, () => false)
    if (had) await fs.rename(target, previous)
    await fs.rename(temporary, target)
    return target
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
    await fs.rm(previous, { recursive: true, force: true })
  }
}

export async function removeInstalledPlugin(installRoot: string, name: string): Promise<void> {
  if (!PLUGIN_NAME.test(name)) throw new Error(`"${name}" is not a valid plugin name.`)
  await fs.rm(path.join(installRoot, name), { recursive: true, force: true })
}

/** Les dossiers de skills des plugins allumés, pour le catalogue des skills avancés. */
export function pluginSkillDirs(list: PluginList, disabled: readonly string[]): { name: string; dir: string }[] {
  return list.plugins
    .filter((p) => !disabled.includes(p.name) && p.skills.length > 0)
    .map((p) => ({ name: p.name, dir: path.join(p.dir, "skills") }))
}
