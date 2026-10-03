import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AgentKind } from "../shared/harness"
import type { SkillCatalog, SkillEntry, SkillPack } from "../shared/skills"

const exec = promisify(execFile)
const IGNORED = new Set([".git", "node_modules", "vendor", "dist", "out", "test", "tests", "fixtures"])
const MAX_SKILLS = 400

export function parseSkill(text: string, fallback: string): { name: string; description: string } {
  const front = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ""
  const field = (key: string): string => {
    const lines = front.split(/\r?\n/)
    const index = lines.findIndex((line) => line.startsWith(`${key}:`))
    if (index < 0) return ""
    let value = lines[index].slice(key.length + 1).trim()
    if (/^[>|][-+]?\s*$/.test(value)) {
      value = ""
      for (const line of lines.slice(index + 1)) {
        if (line && !/^\s/.test(line)) break
        value += ` ${line.trim()}`
      }
    }
    return value.replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ").trim()
  }
  return { name: (field("name") || fallback).slice(0, 120), description: (field("description") || "No description provided.").slice(0, 700) }
}

export function skillRoots(kind: AgentKind, project: string, home = os.homedir(), env = process.env): string[] {
  const native = kind === "claude" ? ".claude" : kind === "codex" ? ".codex" : kind === "qwen" ? ".qwen" : ".mimo"
  const user = kind === "codex" && env.CODEX_HOME ? env.CODEX_HOME : path.join(home, native)
  return [...new Set([
    path.join(project, native, "skills"), path.join(project, ".agents", "skills"),
    path.join(user, "skills"), path.join(home, ".agents", "skills"),
  ])]
}

export async function listPacks(packsDir: string): Promise<SkillPack[]> {
  const dirs = await fs.readdir(packsDir, { withFileTypes: true }).catch(() => [])
  const packs: SkillPack[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith(".")) continue
    try {
      const root = path.join(packsDir, dir.name)
      const record = JSON.parse(await fs.readFile(path.join(root, ".zyvro-pack.json"), "utf8")) as SkillPack
      const repo = githubRepository(record.repository)
      if (repo.id === dir.name && /^[a-f0-9]{40,64}$/.test(record.revision)) {
        packs.push({ id: repo.id, repository: repo.url, revision: record.revision, path: root })
      }
    } catch { /* An interrupted download is not an installed pack. */ }
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id))
}

export async function discoverSkills(kind: AgentKind, project: string, packsDir: string, home = os.homedir(), env = process.env): Promise<SkillCatalog> {
  const roots = skillRoots(kind, project, home, env)
  const packs = await listPacks(packsDir)
  const skills: SkillEntry[] = []
  const warnings: string[] = []
  const visited = new Set<string>()
  let directories = 0
  const walk = async (dir: string, source: SkillEntry["source"], pack: string | null, depth: number): Promise<void> => {
    if (depth > 6 || skills.length >= MAX_SKILLS || ++directories > 4000) return
    let real: string
    try { real = await fs.realpath(dir) } catch { return }
    if (visited.has(real)) return
    visited.add(real)
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) }
    catch { warnings.push(`Could not read ${dir}`); return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name !== "SKILL.md" || !entry.isFile()) continue
      const file = path.join(dir, entry.name)
      try {
        const handle = await fs.open(file, "r")
        let text: string
        try {
          const buffer = Buffer.alloc(16 * 1024)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          text = buffer.subarray(0, bytesRead).toString("utf8")
        } finally { await handle.close() }
        const identity = pack ? `${pack}/${path.relative(path.join(packsDir, pack), file)}` : path.join(real, entry.name)
        skills.push({
          id: createHash("sha256").update(identity).digest("hex").slice(0, 24),
          ...parseSkill(text, path.basename(dir)), path: file, source, pack,
        })
      } catch { warnings.push(`Could not read ${file}`) }
    }
    for (const entry of entries) {
      // Local skill managers use symlinks; downloaded repositories cannot use
      // them to expose arbitrary local files as members of their pack.
      if (!IGNORED.has(entry.name) && (entry.isDirectory() || (!pack && entry.isSymbolicLink()))) {
        await walk(path.join(dir, entry.name), source, pack, depth + 1)
      }
    }
  }
  for (const root of roots) {
    const relative = path.relative(project, root)
    await walk(root, !relative.startsWith("..") && !path.isAbsolute(relative) ? "project" : "user", null, 0)
  }
  for (const pack of packs) await walk(pack.path, "pack", pack.id, 0)
  if (skills.length >= MAX_SKILLS || directories > 4000) warnings.push("The skill catalog reached its scan limit. Narrow the installed skill folders to see more.")
  return { skills, packs, roots, warnings }
}

export function githubRepository(input: string): { id: string; url: string } {
  const url = new URL(input.trim())
  const match = url.pathname.replace(/\/$/, "").replace(/\.git$/, "").match(/^\/([\w.-]+)\/([\w.-]+)$/)
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !match || [".", ".."].includes(match[1]) || [".", ".."].includes(match[2])) {
    throw new Error("Use a GitHub repository URL: https://github.com/owner/repository")
  }
  const slug = `${match[1]}/${match[2]}`.toLowerCase()
  return { id: `${match[1]}--${match[2]}-${createHash("sha256").update(slug).digest("hex").slice(0, 8)}`.toLowerCase(), url: `https://github.com/${slug}` }
}

const downloads = new Map<string, Promise<SkillPack>>()

/** Download only. No hooks, setup scripts or model calls run as a side effect. */
/**
 * `git` is the executable, or `[executable, ...leading args]` — the latter lets
 * a check run a Node script as Git on Windows, which cannot start a shebang
 * script.
 */
export function downloadPack(repository: string, packsDir: string, git: string | string[] = "git"): Promise<SkillPack> {
  const [gitFile, ...gitPrefix] = Array.isArray(git) ? git : [git]
  const repo = githubRepository(repository)
  const key = path.join(packsDir, repo.id)
  const running = downloads.get(key)
  if (running) return running
  const task = (async () => {
    const existing = (await listPacks(packsDir)).find((pack) => pack.id === repo.id)
    if (existing) return existing
    await fs.mkdir(packsDir, { recursive: true })
    const temporary = path.join(packsDir, `.download-${randomUUID()}`)
    try {
      await exec(gitFile, [...gitPrefix, "-c", `core.hooksPath=${path.join(packsDir, ".no-hooks")}`, "-c", "protocol.file.allow=never", "clone", "--template=", "--depth", "1", "--single-branch", "--", `${repo.url}.git`, temporary], {
        timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
      })
      const { stdout } = await exec(gitFile, [...gitPrefix, "-C", temporary, "rev-parse", "HEAD"], { timeout: 10_000, windowsHide: true })
      const pack = { id: repo.id, repository: repo.url, revision: stdout.trim(), path: key }
      const record = path.join(temporary, ".zyvro-pack.json")
      // A repository may already contain this name, including as a symlink.
      // Replace the entry itself before creating our own receipt.
      await fs.rm(record, { force: true, recursive: true })
      await fs.writeFile(record, JSON.stringify(pack), { mode: 0o600, flag: "wx" })
      await fs.rename(temporary, key)
      return pack
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  })().finally(() => downloads.delete(key))
  downloads.set(key, task)
  return task
}
