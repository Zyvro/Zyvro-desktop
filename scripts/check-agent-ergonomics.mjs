import { build, transform } from "esbuild"
import { readFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
const root = path.resolve(import.meta.dirname, "..")
const panel = readFileSync(path.join(root, "src/renderer/panels/AgentPanel.tsx"), "utf8")
const terminalOpen = panel.slice(panel.indexOf("async function openInTerminal("), panel.indexOf("async function dispatch("))
const terminalCalls = []
const terminalContext = vm.createContext({ useWorkspace: { getState: () => ({ setPanel: (...args) => terminalCalls.push(args) }) }, askHarness: (...args) => terminalCalls.push(args) })
vm.runInContext((await transform(`${terminalOpen}\nglobalThis.openInTerminal = openInTerminal`, { loader: "ts" })).code, terminalContext)
for (const kind of ["claude", "codex", "qwen", "mimo"]) {
  terminalCalls.length = 0
  await terminalContext.openInTerminal(kind, "conversation", "chosen-model")
  assert.deepEqual(terminalCalls, [["terminal", true], [kind, "chosen-model", "conversation"]], "native handoff preserves harness, model and conversation in a dedicated terminal")
}
const handler = panel.slice(panel.indexOf("  const onKeyDown ="), panel.indexOf("  const useExample ="))
const js = (await transform(`${handler}\nglobalThis.onKeyDown = onKeyDown`, { loader: "ts" })).code
let sends = 0
let prevented = 0
const context = vm.createContext({ thread: { id: "a", turnId: null }, draft: "こんにちは", isStopKey: () => false, menuOuvert: false, inHistory: () => false, envoyer: () => sends++ })
vm.runInContext(js, context)
const key = (isComposing = false, keyCode = 13, shiftKey = false) => ({ key: "Enter", nativeEvent: { isComposing }, keyCode, shiftKey, preventDefault: () => prevented++ })
context.onKeyDown(key(true))
context.onKeyDown(key(false, 229))
context.onKeyDown(key(false, 13, true))
assert.equal(sends, 0, "IME confirmation and Shift+Enter must not spend a model turn")
assert.equal(prevented, 0)
context.onKeyDown(key())
assert.equal(sends, 1)
const sendButton = panel.slice(panel.lastIndexOf('onClick={() => void envoyer(draft)}'))
const expression = /disabled=\{([^\n]+)\}/.exec(sendButton)[1]
const enabledFor = (draft, images, busy = false) => !vm.runInNewContext(expression, { disabled: false, reecriture: { busy }, draft, thread: { images } })
assert.equal(enabledFor("", []), false)
assert.equal(enabledFor("", [{ id: "screenshot" }]), true, "an image alone is a valid message")
assert.equal(enabledFor("hello", []), true)
assert.equal(enabledFor("hello", [], true), false)

// A slow rewrite must neither overwrite a newer draft nor dispatch into the
// session/project selected while it was pending.
const rewriteHandlers = panel.slice(panel.indexOf("  const canApplyRewrite ="), panel.indexOf("  const stop ="))
for (const change of ["none", "draft", "session", "project"]) {
  for (const autoSend of [true, false]) {
    let finishRewrite
    let currentDraft = "original"
    let currentSession = "a"
    let currentRoot = "/first"
    const sent = []
    let feedback
    const rewriteContext = vm.createContext({
      thread: { id: "a" }, ouRoot: "/first", blank: false, draft: "original",
      activeThread: () => ({ id: currentSession }),
      useWorkspace: { getState: () => ({ root: currentRoot }) },
      draftShown: () => currentDraft,
      setDraft: (value) => { currentDraft = value },
      reecriture: { busy: false, sortie: null },
      setReecriture: (fn) => { feedback = fn({}) },
      activeSynthesis: () => ({ mode: "short", autoSend }),
      isLoginCommand: () => false,
      reecrire: () => new Promise((resolve) => { finishRewrite = resolve }),
      send: async (value) => { sent.push(value) },
      requestAnimationFrame: () => {},
    })
    vm.runInContext((await transform(`${rewriteHandlers}\nglobalThis.envoyer = envoyer`, { loader: "ts" })).code, rewriteContext)
    const pending = rewriteContext.envoyer("original")
    if (change === "draft") currentDraft = "new text"
    if (change === "session") currentSession = "b"
    if (change === "project") currentRoot = "/second"
    finishRewrite("rewritten")
    await pending
    if (change === "none") {
      assert.deepEqual(sent, autoSend ? ["rewritten"] : [])
      assert.equal(currentDraft, autoSend ? "original" : "rewritten")
    } else {
      assert.deepEqual(sent, [], `${change}: no stale auto-send`)
      assert.equal(currentDraft, change === "draft" ? "new text" : "original")
      assert.match(feedback.erreur, /changed/)
    }
  }
}

// Busy state can change during synthesis. Use the current thread when the
// rewrite finishes, even if the event handler captured an older render.
const sendHandler = panel.slice(panel.indexOf("  const send = async"), panel.indexOf("  // L'auto-synthèse"))
for (const currentBusy of [true, false]) {
  let liveThread = { id: "a", busy: currentBusy, images: [], queued: [] }
  const dispatched = []
  const sendContext = vm.createContext({
    thread: { id: "a", busy: !currentBusy }, threadById: () => liveThread,
    isLoginCommand: () => false, rememberPrompt: () => {}, leaveHistory: () => {},
    setDraft: () => {}, releaseBlank: () => {}, blank: false, composer: { current: null },
    mapThread: (_id, fn) => { liveThread = fn(liveThread) },
    nextMessageId: () => "q", canSteer: () => false,
    dispatch: async (...args) => { dispatched.push(args) },
  })
  vm.runInContext((await transform(`${sendHandler}\nglobalThis.send = send`, { loader: "ts" })).code, sendContext)
  await sendContext.send("rewritten")
  assert.equal(liveThread.queued.length, currentBusy ? 1 : 0)
  assert.equal(dispatched.length, currentBusy ? 0 : 1)
}

// Failed answers remain available, duplicate clicks cannot send twice, and
// a withdrawn request must not reappear if its pending IPC later rejects.
const answerHandler = panel.slice(panel.indexOf("async function answerAsk("), panel.indexOf("// ---------------------------------------------------------------------------\n// Tabs"))
let replyCalls = 0
let resolveReply, rejectReply
const answerContext = vm.createContext({
  state: { asks: [{ id: "question", questions: [] }] },
  window: { zyvro: { agent: { answerPermission: () => { replyCalls++; return new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject }) } } } },
  commit: (next) => { answerContext.state = next },
})
vm.runInContext((await transform(`${answerHandler}\nglobalThis.answerAsk = answerAsk`, { loader: "ts" })).code, answerContext)
const firstReply = answerContext.answerAsk("question", true, { q: ["yes"] })
assert.equal(answerContext.state.asks[0].answering, true)
await answerContext.answerAsk("question", true)
assert.equal(replyCalls, 1)
rejectReply(new Error("connection lost"))
await firstReply
assert.equal(answerContext.state.asks.length, 1)
assert.equal(answerContext.state.asks[0].answering, false)
assert.match(answerContext.state.asks[0].error, /connection lost/)
const retryReply = answerContext.answerAsk("question", true, { q: ["yes"] })
resolveReply(true)
await retryReply
assert.equal(answerContext.state.asks.length, 0)
answerContext.state.asks = [{ id: "withdrawn" }]
const withdrawn = answerContext.answerAsk("withdrawn", false)
answerContext.state.asks = []
rejectReply(new Error("agent stopped"))
await withdrawn
assert.equal(answerContext.state.asks.length, 0)

const dir = path.join(root, "node_modules/.zyvro-session-ergonomics-check")
mkdirSync(dir, { recursive: true })
await build({ entryPoints: [path.join(root, "src/renderer/panels/AgentSessions.tsx")], outfile: path.join(dir, "sessions.cjs"), bundle: true, format: "cjs", platform: "node", jsx: "automatic", alias: { "@": path.resolve(root, "../Zyvro-frontend/src") }, logLevel: "silent" })
const { matchingSessions, sessionStatus } = createRequire(import.meta.url)(path.join(dir, "sessions.cjs"))
const sessions = [
  { id: "a", title: "Windows update", kind: "claude", model: "opus", busy: true, pending: null, messages: [], queued: [] },
  { id: "b", title: "Readme", kind: "codex", model: null, busy: false, pending: null, messages: [{ error: "login required" }], queued: [] },
  { id: "c", title: "Nightly check", kind: "qwen", model: null, busy: false, pending: {}, messages: [], queued: [] },
]
assert.deepEqual(matchingSessions(sessions, "UPDATE opus", false).map((s) => s.id), ["a"])
assert.deepEqual(matchingSessions(sessions, "codex", false).map((s) => s.id), ["b"])
assert.deepEqual(matchingSessions(sessions, "", true).map((s) => s.id), ["a"])
assert.deepEqual(matchingSessions(sessions, "readme", true), [])
assert.deepEqual(sessions.map(sessionStatus), ["Running", "Error", "Scheduled"])
assert.equal(sessionStatus({ ...sessions[0], busy: false }), "Idle", "idle is not a claim of successful completion")

// Quick Open: pressing Down before asynchronous results arrive must not
// produce -1, which used to leave Enter without a selected result.
const quick = readFileSync(path.join(root, "src/renderer/panels/QuickOpen.tsx"), "utf8")
const indexExpression = /const index = (.*)/.exec(quick)[1]
const indexFor = (choisi, total) => vm.runInNewContext(indexExpression, { choisi, total })
assert.equal(indexFor(-1, 3), 0)
assert.equal(indexFor(20, 2), 1)
assert.equal(indexFor(0, 0), 0)
console.log("Agent ergonomics: composition, image-only messages, session filtering/status, Quick Open selection passed.")
