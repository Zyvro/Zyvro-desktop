// Les fonctions de l'agent, en plugins (shared/plugins).
//
// Ce qui casse en silence ici :
//
// 1. **Une mise à jour qui éteint quelque chose.** Sans réglage, tout est
//    allumé : c'est ce que faisait l'application avant les plugins.
// 2. **Un choix d'avant perdu.** « Advanced skills » était `advancedSkills` ;
//    un fichier qui le porte encore doit garder son « off ».
// 3. **Un settings.json abîmé** (un identifiant inconnu, une chaîne au lieu
//    d'un booléen) qui ferait un plugin ni allumé ni éteint.
// 4. **Un plugin sans module, ou un module que le principal ignore** : le
//    registre du rendu et les deux décisions prises au lancement du tour
//    (la mémoire, les skills) doivent nommer le catalogue.
//
//     node scripts/check-plugins.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import assert from "node:assert/strict"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-plugins-check")
mkdirSync(dir, { recursive: true })
const load = async (entry, name) => {
  await build({ entryPoints: [path.join(ROOT, entry)], outfile: path.join(dir, name), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
  return createRequire(import.meta.url)(path.join(dir, name))
}
const p = await load("src/shared/plugins.ts", "plugins.cjs")
const s = await load("src/shared/settings.ts", "settings.cjs")

const ok = (name) => console.log(`  ok    ${name}`)

// Le catalogue : des identifiants uniques, chaque entrée dit ce qu'elle fait et
// ce qu'éteindre veut dire.
const ids = p.AGENT_PLUGINS.map((x) => x.id)
assert.equal(new Set(ids).size, ids.length)
for (const plugin of p.AGENT_PLUGINS) {
  assert.ok(plugin.name && plugin.description && plugin.whenOff, plugin.id)
  assert.ok(["project", "conversation", "answers", "app"].includes(plugin.section), plugin.id)
}
for (const id of ["tasks", "memory", "permissions", "synthesis", "skills"]) assert.ok(ids.includes(id), id)
ok("catalogue: unique ids, each says what it does and what turning it off means")

// 1. Tout allumé par défaut.
assert.deepEqual(p.sanitizePlugins(undefined), p.DEFAULT_PLUGINS)
assert.ok(Object.values(p.DEFAULT_PLUGINS).every((v) => v === true))
assert.deepEqual(s.sanitizeSettings({}).agent.plugins, p.DEFAULT_PLUGINS)
assert.equal(p.pluginOn(undefined, "memory"), true)
assert.equal(p.pluginOn({}, "memory"), true)
assert.equal(p.pluginOn({ plugins: { memory: false } }, "memory"), false)
ok("everything on by default, and for a client that sends no plugins")

// 2. Le réglage d'avant.
assert.equal(s.sanitizeSettings({ agent: { advancedSkills: false } }).agent.plugins.skills, false)
assert.equal(s.sanitizeSettings({ agent: { advancedSkills: false, plugins: { skills: true } } }).agent.plugins.skills, true)
assert.ok(!("advancedSkills" in s.sanitizeSettings({ agent: { advancedSkills: false } }).agent))
ok("legacy advancedSkills carried over, the new switch wins, the old field is not written back")

// 3. Ce qui ne veut rien dire.
const sali = p.sanitizePlugins({ memory: false, tasks: "off", ghost: false, __proto__: { usage: false } })
assert.equal(sali.memory, false)
assert.equal(sali.tasks, true)
assert.equal(sali.usage, true)
assert.ok(!("ghost" in sali))
assert.deepEqual(p.sanitizePlugins([false, false]), p.DEFAULT_PLUGINS)
assert.deepEqual(Object.keys(sali).sort(), [...ids].sort())
ok("unknown ids dropped, non-booleans keep the default, every id present")

// Un aller-retour par le fichier de réglages ne change rien.
const once = s.sanitizeSettings({ agent: { plugins: { synthesis: false, bugReport: false } } })
assert.deepEqual(s.sanitizeSettings(JSON.parse(JSON.stringify(once))), once)
ok("settings round-trip")

// 4. Le registre du rendu et le principal.
const registre = readFileSync(path.join(ROOT, "src/renderer/plugins/index.tsx"), "utf8")
for (const id of ids) assert.match(registre, new RegExp(`\\n  ${id}: \\w+Plugin,`), `module for ${id}`)
const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
assert.match(ipc, /pluginOn\(agentSettings, "memory"\) \? await memoryForAgent\(root\) : null/)
assert.match(ipc, /ctx\?\.advancedSkills === true && pluginOn\(agentSettings, "skills"\)/)
const panneau = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
for (const cable of ["TaskQueueButton", "MemoryButton", "PermissionPicker", "SynthesisPicker", "SkillsButton", "ContextCompact", "BugButton", "synthesisSettings()"]) {
  assert.ok(!panneau.includes(cable), `AgentPanel still wires ${cable} itself`)
}
assert.match(readFileSync(path.join(ROOT, "src/renderer/state/tasks.ts"), "utf8"), /if \(!pluginOn\(getSettings\(\)\.agent, "tasks"\)\) return/)
ok("every plugin has a module; memory and skills gated in main; the panel wires none of them directly")

console.log("check-plugins: all good")
