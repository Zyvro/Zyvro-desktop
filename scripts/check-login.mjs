import { build, transform } from "esbuild"
import { readFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import vm from "node:vm"
import assert from "node:assert/strict"

const root = path.resolve(import.meta.dirname, "..")
const dir = path.join(root, "node_modules/.zyvro-login-check")
mkdirSync(dir, { recursive: true })
await build({ entryPoints: [path.join(root, "src/shared/login.ts")], outfile: path.join(dir, "login.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
const { isLoginCommand, loginArgs } = createRequire(import.meta.url)(path.join(dir, "login.cjs"))
for (const text of ["/login", " /LOGIN ", "/auth"]) assert.equal(isLoginCommand(text), true)
for (const text of ["ask about /login", "/login/file", "/login; echo secret", "/authentication"]) assert.equal(isLoginCommand(text), false)
assert.deepEqual(loginArgs("claude"), ["auth", "login"])
assert.deepEqual(loginArgs("codex"), ["login"])
assert.deepEqual(loginArgs("mimo"), ["auth", "login"])
assert.deepEqual(loginArgs("qwen"), ["--prompt-interactive", "/auth"])

// Execute the actual send/synthesis handlers: even while busy, /login opens
// the selected harness and cannot enter the paid model path or clear images.
const panel = readFileSync(path.join(root, "src/renderer/panels/AgentPanel.tsx"), "utf8")
const send = panel.slice(panel.indexOf("  const send = async"), panel.indexOf("  // L'auto-synthèse"))
const envoyer = panel.slice(panel.indexOf("  const envoyer = async"), panel.indexOf("  const reecrireMaintenant"))
const code = (await transform(`${send}\n${envoyer}\nglobalThis.envoyer = envoyer`, { loader: "ts" })).code
for (const kind of ["claude", "codex", "qwen", "mimo"]) {
  for (const busy of [false, true]) {
    const calls = []
    const no = () => { throw new Error("Login reached the model/queue/image mutation path") }
    const ctx = vm.createContext({
      kind, thread: { id: "thread", busy, images: [{ id: "keep" }] }, isLoginCommand,
      composer: { current: { style: {} } }, reecriture: { busy: false },
      synthesisSettings: () => ({ mode: "detailed", autoSend: true }),
      setReecriture: () => {}, rememberPrompt: () => {}, leaveHistory: () => {}, setDraft: (s) => calls.push(["draft", s]),
      useWorkspace: { getState: () => ({ setPanel: (...a) => calls.push(a) }) },
      askLogin: (k) => calls.push(["login", k]), reecrire: no, dispatch: no, mapThread: no, releaseBlank: no,
    })
    vm.runInContext(code, ctx)
    await ctx.envoyer("/login")
    assert.deepEqual(calls, [["draft", ""], ["terminal", true], ["login", kind]])
  }
}

// IPC validates the kind and launches only fixed native arguments, in the
// project's terminal with no gateway environment or model flags.
const ipc = readFileSync(path.join(root, "src/main/ipc.ts"), "utf8")
const handler = ipc.slice(ipc.indexOf('  ipcMain.handle("agent:login-shell"'), ipc.indexOf('  ipcMain.handle("agent:shell"'))
let login
const launches = []
const ctx = vm.createContext({
  ipcMain: { handle: (_name, fn) => { login = fn } }, loginArgs,
  requireWorkspace: () => ({ ws: { terminals: { create: (...args) => { launches.push(args); return { id: "terminal", pty: true } } } } }),
  requireRoot: () => "/project", isAgentKind: (k) => ["claude", "codex", "qwen", "mimo"].includes(k),
  harness: (kind) => ({ bin: kind, install: "install instruction" }),
  locate: (bin) => ({ file: `/bin/${bin}` }), direct: (found) => ({ ...found, prefix: [], shell: false }), process,
})
vm.runInContext((await transform(handler, { loader: "ts" })).code, ctx)
for (const kind of ["claude", "codex", "qwen", "mimo"]) {
  const result = await login({ sender: "renderer" }, kind, 100, 30)
  assert.equal(result.id, "terminal")
  const args = launches.at(-1)
  assert.deepEqual(args.slice(0, 5), ["renderer", "/project", 100, 30, null])
  assert.deepEqual(JSON.parse(JSON.stringify(args[5])), { command: { file: `/bin/${kind}`, args: loginArgs(kind) }, label: `login ${kind}` })
}
await assert.rejects(login({ sender: "renderer" }, "powershell", 80, 24), /not a harness/)
assert.equal(launches.length, 4)
console.log("Login: native CLI routing, IPC validation, busy sessions and auto-synthesis bypass passed.")
