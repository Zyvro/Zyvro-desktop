// Exercise discovery, filtering and the download transaction on local fixtures.
// No network requests, model calls or real user configuration changes.
import assert from "node:assert/strict"
import { build } from "esbuild"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const root = path.resolve(import.meta.dirname, "..")
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zyvro-skills-check-"))
try {
  await build({
    stdin: { contents: 'export * from "./src/main/skills"; export * from "./src/shared/skills"; export * from "./src/shared/settings"', resolveDir: root, loader: "ts" },
    outfile: path.join(dir, "checks.cjs"), platform: "node", format: "cjs", bundle: true, logLevel: "silent",
  })
  const m = createRequire(import.meta.url)(path.join(dir, "checks.cjs"))
  const home = path.join(dir, "home"), project = path.join(dir, "project"), packs = path.join(dir, "packs")
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
  const skill = (name) => `---\nname: ${name}\ndescription: >-\n  Review changes\n  and identify bugs.\n---\nPRIVATE FULL INSTRUCTIONS, LOAD ONLY ON DEMAND.\n`
  await write(path.join(home, ".claude/skills/review/SKILL.md"), skill("claude-review"))
  await write(path.join(home, ".codex/skills/review/SKILL.md"), skill("codex-review"))
  await write(path.join(project, ".agents/skills/local/SKILL.md"), skill("local-review"))
  await fs.symlink(path.join(home, ".claude/skills"), path.join(home, ".claude/skills/cycle"))
  let catalog = await m.discoverSkills("claude", project, packs, home, {})
  assert.deepEqual(catalog.skills.map((s) => s.name).sort(), ["claude-review", "local-review"])
  assert.equal(catalog.skills[0].description, "Review changes and identify bugs.")
  assert.ok(!JSON.stringify(catalog).includes("PRIVATE FULL INSTRUCTIONS"))
  assert.equal(catalog.skills.find((s) => s.name === "local-review").source, "project")
  catalog = await m.discoverSkills("codex", project, packs, home, {})
  assert.deepEqual(catalog.skills.map((s) => s.name).sort(), ["codex-review", "local-review"])
  const custom = path.join(home, "custom-codex")
  await write(path.join(custom, "skills/custom/SKILL.md"), skill("custom"))
  assert.ok((await m.discoverSkills("codex", project, packs, home, { CODEX_HOME: custom })).skills.some((s) => s.name === "custom"))
  console.log("ok: project/user skills, agent isolation, custom home, symlink cycles, metadata only")

  const a = m.sanitizeSettings({ fontSize: 17, agent: { defaultKind: "bad", defaultModels: { claude: " model ", codex: 42 }, disabledSkills: ["x", "x", null] } })
  assert.equal(a.fontSize, 17)
  assert.equal(a.agent.defaultKind, "claude")
  assert.deepEqual(a.agent.defaultModels, { claude: "model" })
  assert.deepEqual(a.agent.disabledSkills, ["x"])
  assert.equal(m.sanitizeSettings({}).agent.advancedSkills, true)
  const entry = { id: "x", name: "Review", description: "Find bugs", path: "/skill/SKILL.md", source: "pack", pack: "p" }
  assert.equal(m.skillEnabled(entry, { ...a.agent, disabledSkills: [], enabledPacks: ["p"] }), true)
  assert.equal(m.skillEnabled(entry, a.agent), false)
  assert.equal(m.skillEnabled(entry, { ...a.agent, disabledSkills: [], enabledPacks: [] }), false)
  assert.match(m.promptWithSkills("Review my changes", [entry], true), /\/skill\/SKILL.md/)
  assert.ok(!m.promptWithSkills("Review my changes", [entry], false).includes("/skill/SKILL.md"))
  assert.match(m.promptWithSkills("Review my changes", [entry], false), /OFF for this turn/)
  assert.equal(m.promptWithSkills("/compact", [entry], true), "/compact")
  assert.equal(m.promptWithSkills("/gstack:review diff", [entry], true), "/gstack:review diff")
  assert.match(m.promptWithSkills("/tmp/example.ts needs review", [entry], true), /ON for this turn/)
  console.log("ok: legacy settings, invalid values, disabled packs/skills, turn catalog and native slash commands")

  for (const bad of ["https://github.com/o/r/tree/main", "file:///tmp/repo", "https://evil.com/o/r", "https://user:pass@github.com/o/r", "https://github.com/o/r?x=y", "git@github.com:o/r"]) {
    assert.throws(() => m.githubRepository(bad))
  }
  assert.equal(m.githubRepository("https://github.com/Owner/Repo.git").url, "https://github.com/owner/repo")
  assert.notEqual(m.githubRepository("https://github.com/a--b/c").id, m.githubRepository("https://github.com/a/b--c").id)
  // Fake Git behaves like clone + rev-parse, including a hostile receipt symlink.
  const sentinel = path.join(dir, "untouched")
  await fs.writeFile(sentinel, "keep me")
  const git = path.join(dir, "git-fixture")
  await write(git, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);if(a.includes('clone')){const d=a.at(-1);fs.mkdirSync(path.join(d,'review'),{recursive:true});fs.writeFileSync(path.join(d,'review','SKILL.md'),${JSON.stringify(skill("pack-review"))});fs.symlinkSync(${JSON.stringify(sentinel)},path.join(d,'.zyvro-pack.json'));}else{console.log('a'.repeat(40));}\n`)
  await fs.chmod(git, 0o755)
  const [one, two] = await Promise.all([m.downloadPack("https://github.com/owner/repo", packs, git), m.downloadPack("https://github.com/owner/repo", packs, git)])
  assert.equal(one.id, two.id)
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep me")
  assert.equal((await m.listPacks(packs)).length, 1)
  assert.ok((await fs.readdir(packs)).every((n) => !n.startsWith(".download-")))
  const downloaded = await m.discoverSkills("claude", project, packs, home, {})
  const member = downloaded.skills.find((s) => s.name === "pack-review")
  assert.equal(member.pack, one.id)
  assert.equal(member.source, "pack")
  assert.equal((await m.downloadPack("https://github.com/owner/repo", packs, "missing-git")).id, one.id)
  await assert.rejects(m.downloadPack("https://github.com/owner/failure", packs, "missing-git"))
  assert.ok((await fs.readdir(packs)).every((n) => !n.startsWith(".download-")))
  console.log("ok: repository validation, atomic/idempotent download, concurrent clicks, symlink receipt and failed-download cleanup")
} finally { await fs.rm(dir, { recursive: true, force: true }) }
