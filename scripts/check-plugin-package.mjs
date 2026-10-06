// Les plugins d'agent en paquets (shared/pluginPackage, main/agentPlugins).
//
// Ce qui casse en silence ici :
//
// 1. **Une empreinte qui diverge du serveur.** Elle ne casse pas bruyamment :
//    toutes les installations sont refusées, ou une réécriture passe. Le
//    vecteur de features/store-plugins.md est rejoué, le même que le test Go.
// 2. **Une grammaire plus large ou plus étroite que celle de la boutique** : un
//    plugin publié qui ne s'installe pas, ou un fichier qu'on n'a pas voulu.
// 3. **Plugin Creator, livré avec l'app, qui ne se charge plus** : l'action
//    principale de la fonction disparaîtrait de la barre sans un mot.
// 4. **Un `{{input}}` tapé dans la réponse et réinterprété**, ou des skills
//    oubliés devant la demande d'une action `skills: "all"`.
// 5. **Les skills d'un plugin éteint encore envoyés**, ou le dossier livré
//    resté dans l'asar, où l'agent ne peut pas le lire.
//
//     node scripts/check-plugin-package.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import assert from "node:assert/strict"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-plugin-package-check")
mkdirSync(dir, { recursive: true })
const load = async (entry, name) => {
  await build({ entryPoints: [path.join(ROOT, entry)], outfile: path.join(dir, name), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
  return createRequire(import.meta.url)(path.join(dir, name))
}
const pkg = await load("src/shared/pluginPackage.ts", "pluginPackage.cjs")
const disk = await load("src/main/agentPlugins.ts", "agentPlugins.cjs")
const skills = await load("src/main/skills.ts", "skills.cjs")

const ok = (name) => console.log(`  ok    ${name}`)
const refuses = (files, pattern, label) => {
  assert.throws(() => pkg.validatePluginFiles(files), pattern, label)
}

// --- 1. L'empreinte : le vecteur de la spec, octet pour octet.
const vector = [
  { path: "zyvro-plugin.json", code: '{"name":"demo","version":"1.0.0","description":"d","actions":[]}' },
  { path: "skills/a/SKILL.md", code: "---\nname: a\ndescription: b\n---\nhi\n" },
]
assert.equal(disk.pluginDigest("demo", "1.0.0", vector), "1d824f59f11fb1d35f115ed14779a200f3e3973f548096f6e5825822761cfbef")
assert.equal(disk.pluginDigest("demo", "1.0.0", [...vector].reverse()), disk.pluginDigest("demo", "1.0.0", vector))
ok("the digest reproduces the store's test vector, whatever the file order")

// --- 2. La grammaire.
const manifest = (extra = {}) => ({ path: "zyvro-plugin.json", code: JSON.stringify({ name: "demo", version: "1.0.0", ...extra }) })
const skill = { path: "skills/a/SKILL.md", code: "---\nname: a\ndescription: b\n---\nbody\n" }
const action = (extra = {}) => ({ id: "go", label: "Go", prompt: "Do it", ...extra })

const parsed = pkg.validatePluginFiles([manifest({ actions: [action()] }), skill])
assert.equal(parsed.icon, "puzzle")
assert.equal(parsed.actions[0].skills, "all")
assert.equal(parsed.actions[0].input, null)
assert.deepEqual(parsed.skills, [{ dir: "a", name: "a", description: "b", path: "skills/a/SKILL.md" }])
// null vaut absent, comme côté Go.
const nulls = pkg.validatePluginFiles([manifest({ description: null, icon: null, actions: [action({ input: null, description: null, skills: null })] }), skill])
assert.equal(nulls.description, "")
assert.equal(nulls.actions[0].input, null)
ok("optional fields default, and null counts as absent")

refuses([manifest(), skill, { path: "../evil.md", code: "x" }], /not allowed/, "path escape")
refuses([manifest(), skill, { path: "skills/a/run.sh", code: "x" }], /not allowed/, "non-markdown")
refuses([manifest(), skill, { path: "skills/a/b/c.md", code: "x" }], /not allowed/, "too deep")
refuses([manifest(), { path: "skills/A/SKILL.md", code: skill.code }], /not allowed/, "uppercase skill dir")
refuses([manifest(), skill, skill], /twice/, "duplicate path")
refuses([skill], /zyvro-plugin\.json is missing/, "no manifest")
refuses([manifest(), { path: "skills/a/notes.md", code: "x" }], /no SKILL\.md/, "skill folder without SKILL.md")
refuses([manifest(), { path: "skills/a/SKILL.md", code: "---\ndescription: b\n---\n" }], /no name/, "frontmatter without name")
refuses([manifest(), { path: "skills/a/SKILL.md", code: "---\nname: a\n---\n" }], /no description/, "frontmatter without description")
refuses([manifest({ colour: "red" }), skill], /unknown key "colour"/, "unknown manifest key")
refuses([manifest({ actions: [action({ promt: "x" })] }), skill], /unknown key "promt"/, "unknown action key")
refuses([manifest({ actions: [action({ input: { label: "Q", hint: "x" }, prompt: "{{input}}" })] }), skill], /unknown key "hint"/, "unknown input key")
refuses([manifest({ icon: "banana" }), skill], /icon/, "unknown icon")
refuses([manifest({ actions: [action({ input: { label: "Q" } })] }), skill], /must contain \{\{input\}\}/, "input without {{input}}")
refuses([manifest({ actions: [action({ prompt: "x {{input}}" })] }), skill], /has no input/, "{{input}} without input")
refuses([manifest({ actions: [action(), action()] }), skill], /used twice/, "duplicate action id")
refuses([manifest({ actions: Array.from({ length: 9 }, (_, i) => action({ id: `a${i}` })) }), skill], /limit of 8/, "too many actions")
refuses([manifest({ actions: [action({ skills: "some" })] }), skill], /"all" or "none"/, "bad skills mode")
refuses([manifest({ name: "Demo" }), skill], /name/, "uppercase name")
refuses([manifest({ version: "v1" }), skill], /version/, "bad version")
refuses([manifest({ actions: [action({ label: 42 })] }), skill], /must be a string/, "wrong type")
refuses([manifest()], /at least one action or one skill/, "empty plugin")
refuses([manifest(), skill, { path: "README.md", code: "x".repeat(256 * 1024 + 1) }], /over the limit/, "file too large")
// Des caractères, pas des unités UTF-16 : 60 emojis tiennent dans un libellé.
pkg.validatePluginFiles([manifest({ actions: [action({ label: "🙂".repeat(60) })] }), skill])
refuses([manifest({ actions: [action({ label: "🙂".repeat(61) })] }), skill], /over the limit of 60/, "61 emojis")
ok("every rule of the store's grammar is enforced the same way")

// --- 3. Plugin Creator, tel qu'il est livré.
const creatorDir = path.join(ROOT, "resources", "plugins", "plugin-creator")
const creator = await disk.loadPluginDir(creatorDir)
assert.equal(creator.pkg.name, "plugin-creator")
assert.deepEqual(creator.pkg.actions.map((a) => a.id), ["create", "improve"])
assert.ok(creator.pkg.actions.every((a) => a.input && a.skills === "all"))
assert.deepEqual(creator.pkg.skills.map((s) => s.dir).sort(), [
  "zyvro-plugin-design", "zyvro-plugin-format", "zyvro-plugin-publishing", "zyvro-plugin-testing", "zyvro-skill-writing",
])
// Chaque skill que les actions citent existe.
for (const action of creator.pkg.actions) {
  for (const cited of action.prompt.match(/zyvro-[a-z-]+/g) ?? []) {
    assert.ok(creator.pkg.skills.some((s) => s.name === cited), `${action.id} cites ${cited}, which the plugin does not ship`)
  }
}
ok("Plugin Creator loads, with its two actions and the five skills its prompts cite")

// --- 4. Le prompt d'une action.
const files = [{ name: "x", description: "y", file: "/p/skills/x/SKILL.md" }]
const sent = pkg.actionPrompt({ name: "demo" }, { label: "Go", prompt: "Idea: {{input}}. Again: {{input}}", skills: "all" }, "  build {{input}} things ", files)
assert.match(sent, /This request comes from the Zyvro plugin "demo"/)
assert.match(sent, /"file":"\/p\/skills\/x\/SKILL.md"/)
assert.ok(sent.endsWith("Idea: build {{input}} things. Again: build {{input}} things"), sent)
assert.equal(pkg.actionPrompt({ name: "demo" }, { label: "Go", prompt: "Just {{input}}", skills: "none" }, "this", files), "Just this")
ok("an action substitutes its answer once and lists the skills to read first")

// --- 5. Le disque : lecture, préséance, installation.
const tmp = mkdtempSync(path.join(os.tmpdir(), "zyvro-plugins-"))
try {
  const write = (root, name, extra = {}, more = []) => {
    const d = path.join(root, name)
    mkdirSync(path.join(d, "skills", "a"), { recursive: true })
    writeFileSync(path.join(d, "zyvro-plugin.json"), JSON.stringify({ name, version: "1.0.0", ...extra }))
    writeFileSync(path.join(d, "skills", "a", "SKILL.md"), skill.code)
    for (const [file, code] of more) writeFileSync(path.join(d, file), code)
    return d
  }
  const bundled = path.join(tmp, "bundled")
  const installed = path.join(tmp, "installed")
  const project = path.join(tmp, "project")
  write(bundled, "same")
  write(installed, "same", { version: "2.0.0" })
  write(project, "same")
  write(project, "extra", {}, [["notes.txt", "x"]])
  write(project, "hidden", {}, [[".DS_Store", "x"]])
  write(project, "wrongname")
  writeFileSync(path.join(project, "wrongname", "zyvro-plugin.json"), JSON.stringify({ name: "other", version: "1.0.0" }))
  const linked = write(project, "linked")
  symlinkSync(path.join(tmp, "bundled"), path.join(linked, "skills", "b"))

  const list = await disk.listAgentPlugins([
    { origin: "bundled", dir: bundled },
    { origin: "installed", dir: installed },
    { origin: "project", dir: project },
  ])
  const same = list.plugins.find((p) => p.name === "same")
  assert.equal(same.origin, "project")
  assert.deepEqual(same.shadows, ["installed", "bundled"])
  assert.equal(same.skills[0].file, path.join(project, "same", "skills", "a", "SKILL.md"))
  assert.ok(list.plugins.some((p) => p.name === "hidden"), ".DS_Store is ignored")
  const problem = (name) => list.problems.find((p) => p.name === name)?.error ?? ""
  assert.match(problem("extra"), /notes\.txt/)
  assert.match(problem("wrongname"), /folder is "wrongname"/)
  assert.match(problem("linked"), /symbolic link/)
  ok("the project's copy wins and says what it shadows; broken folders are reported with their reason")

  // Les skills des plugins allumés seulement.
  const dirs = disk.pluginSkillDirs(list, ["hidden"])
  assert.ok(dirs.some((d) => d.name === "same") && !dirs.some((d) => d.name === "hidden"))
  const catalog = await skills.discoverSkills("claude", path.join(tmp, "nowhere"), path.join(tmp, "packs"), path.join(tmp, "home"), {}, dirs)
  const fromPlugin = catalog.skills.filter((s) => s.source === "plugin")
  assert.equal(fromPlugin.length, dirs.length)
  assert.ok(fromPlugin.every((s) => s.pack === null))
  ok("only enabled plugins' skills join the advanced-skills catalog, as source \"plugin\"")

  // Installer remplace d'un coup et ne laisse rien traîner.
  await disk.writePluginFiles(installed, "fresh", [manifest(), skill].map((f) => ({ ...f, code: f.code.replace('"demo"', '"fresh"') })))
  await disk.writePluginFiles(installed, "fresh", [{ path: "zyvro-plugin.json", code: JSON.stringify({ name: "fresh", version: "1.0.1", actions: [action()] }) }])
  assert.equal(existsSync(path.join(installed, "fresh", "skills")), false, "the previous version's files are gone")
  assert.equal(JSON.parse(readFileSync(path.join(installed, "fresh", "zyvro-plugin.json"), "utf8")).version, "1.0.1")
  assert.deepEqual((await import("node:fs")).readdirSync(installed).filter((n) => n.startsWith(".")), [])
  await assert.rejects(disk.writePluginFiles(installed, "x", [{ path: "../escape.md", code: "x" }]), /Refused/)
  await assert.rejects(disk.writePluginFiles(installed, "../x", []), /not a valid plugin name/)
  await disk.removeInstalledPlugin(installed, "fresh")
  assert.equal(existsSync(path.join(installed, "fresh")), false)
  ok("an install replaces the previous version whole, and refuses a path outside its folder")
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// --- 6. Le câblage.
const ipc = readFileSync(path.join(ROOT, "src", "main", "ipc.ts"), "utf8")
assert.match(ipc, /pluginSkillDirs\(await listAgentPlugins\(pluginRoots\(root\)\), agentSettings\.disabledPlugins\)/, "agent:send drops disabled plugins' skills")
assert.match(ipc, /app\.isPackaged \? path\.join\(process\.resourcesPath, "plugins"\)/, "bundled plugins are read outside the asar once packaged")
const builder = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8")
assert.equal((builder.match(/- from: resources\/plugins\n\s+to: plugins/g) ?? []).length, 3, "every platform ships resources/plugins as an extra resource")
const settings = await load("src/shared/settings.ts", "settings.cjs")
assert.deepEqual(settings.sanitizeAgentSettings({}).disabledPlugins, [])
assert.deepEqual(settings.sanitizeAgentSettings({ disabledPlugins: ["a", 3, "a"] }).disabledPlugins, ["a"])
ok("the turn, the packaging and the settings know about packaged plugins")
