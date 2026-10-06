// Chaque projet a son chat, quand une fenêtre en tient plusieurs.
//
// Signalé par Jeremy : « quand je passe d'un projet à un autre j'ai encore le
// même chat d'agent ». Un projet qui n'avait encore aucune conversation
// gardait à l'écran celle du projet précédent — la relecture du disque ne
// trouvait rien et ne vidait rien — et ce qu'on y tapait partait dans le fil de
// l'autre. Ce script fait tourner le vrai module du panneau, avec un faux pont
// qui rend des conversations différentes selon le projet actif.
//
//     node scripts/check-agent-projects.mjs
import { build } from "esbuild"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-agent-projects-check")
mkdirSync(dir, { recursive: true })
await build({
  stdin: {
    contents:
      `export { chatState, renameThread } from "${path.join(ROOT, "src/renderer/panels/AgentPanel").replace(/\\/g, "/")}"\n` +
      `export { settle } from "${path.join(ROOT, "src/renderer/state/prompt").replace(/\\/g, "/")}"\n` +
      `export { useWorkspace } from "${path.join(ROOT, "src/renderer/state/workspace").replace(/\\/g, "/")}"\n`,
    resolveDir: ROOT,
    loader: "ts",
  },
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
  alias: { "~": path.join(ROOT, "src/renderer"), "@": path.join(ROOT, "../Zyvro-frontend/src") },
  external: ["monaco-editor", "@xterm/*", "three"],
  // Le module du site refuse de se charger sans elle : elle est gravée dans le
  // bundle à la compilation (voir check-agent-order).
  define: { "process.env.NEXT_PUBLIC_API_URL": JSON.stringify("http://127.0.0.1:0") },
  logLevel: "silent",
})

// Le faux pont : le principal répond pour le projet ACTIF, comme le vrai.
let actif = null
let lenteur = 0
const surDisque = {
  "/p/a": [{ id: "conv-a", title: "Chat de A", kind: "claude", messages: [{ role: "user", text: "question de A", parts: [{ kind: "text", text: "question de A" }] }] }],
  "/p/b": [],
  "/p/c": [{ id: "conv-c", title: "Chat de C", kind: "claude", messages: [{ role: "user", text: "question de C", parts: [{ kind: "text", text: "question de C" }] }] }],
}
const savedConversations = []
const rien = () => () => {}
const agent = new Proxy(
  {
    remember: async (conversation) => { savedConversations.push(conversation) },
    conversations: async () => {
      const pour = actif
      if (lenteur) await new Promise((r) => setTimeout(r, lenteur))
      return surDisque[pour] ?? []
    },
    running: async () => [],
    replay: async () => false,
  },
  { get: (t, k) => (k in t ? t[k] : typeof k === "string" && k.startsWith("on") ? rien : async () => null) }
)
const pont = new Proxy({ agent, platform: "darwin" }, { get: (t, k) => (k in t ? t[k] : new Proxy({}, { get: () => async () => null })) })
globalThis.window = { zyvro: pont, localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }, addEventListener() {}, queueMicrotask }
globalThis.localStorage = globalThis.window.localStorage
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {} }) }

const { chatState, renameThread, settle, useWorkspace } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))
const S = () => useWorkspace.getState()
const d = { ready: true, port: 1, token: "t", project: "", origin: "http://x" }
const ouvrir = async (p) => {
  actif = p
  if (S().projects.some((x) => x.project === p)) S().switchProject({ project: p, name: p, daemon: d })
  else S().addProject({ project: p, name: p, daemon: d })
  await new Promise((r) => setTimeout(r, 30 + lenteur))
}
const titres = () => chatState().threads.map((t) => t.title).join(",")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

await ouvrir("/p/a")
check("le projet A montre sa conversation", titres() === "Chat de A", titres())
await ouvrir("/p/b")
check("**un second projet sans conversation part d'un chat vide, pas de celui de A**", titres() === "New chat" && chatState().threads[0].messages.length === 0, titres())
await ouvrir("/p/a")
check("**revenir sur A rend le chat de A**", titres() === "Chat de A", titres())
await ouvrir("/p/b")
check("et B reste vide", titres() === "New chat", titres())

// Basculer pendant que la relecture de C est en vol : ses conversations
// arrivent alors que B est à l'écran.
lenteur = 80
actif = "/p/c"
S().addProject({ project: "/p/c", name: "/p/c", daemon: d })
await new Promise((r) => setTimeout(r, 10))
actif = "/p/b"
S().switchProject({ project: "/p/b", name: "/p/b", daemon: d })
await new Promise((r) => setTimeout(r, 150))
check("**une relecture qui revient après une bascule ne se pose pas dans le mauvais projet**", titres() === "New chat", titres())
lenteur = 0
await ouvrir("/p/c")
check("et C, quitté avant la fin de sa lecture, se relit en revenant", titres() === "Chat de C", titres())

await ouvrir("/p/a")
chatState().asks = [{ id: "pending-answer", tool: "Read", input: {} }]
await ouvrir("/p/b")
check("changer de projet conserve la question qui attend", chatState().asks[0]?.id === "pending-answer")
chatState().asks = []
await ouvrir("/p/a")
check("revenir dans un projet ne ressuscite pas une question réglée", chatState().asks.length === 0)
const renamed = renameThread("conv-a")
settle("Windows update fix")
await renamed
check("renommer une session garde le nouveau titre", chatState().threads[0].title === "Windows update fix")
check("le titre est sauvegardé avec le transcript", savedConversations.at(-1)?.title === "Windows update fix")
const renamedAgain = renameThread("conv-a")
settle("Login and updates")
await renamedAgain
check("un deuxième renommage sans nouveau message se sauvegarde aussi", savedConversations.at(-1)?.title === "Login and updates" && savedConversations.length === 2)
const canceledRename = renameThread("conv-a")
settle(null)
await canceledRename
check("annuler le renommage ne change rien", savedConversations.length === 2 && chatState().threads[0].title === "Login and updates")
const switchedRename = renameThread("conv-a")
await ouvrir("/p/b")
settle("Wrong project")
await switchedRename
check("un renommage ouvert avant une bascule ne touche pas l'autre projet", savedConversations.length === 2 && titres() === "New chat")

console.log(failures === 0 ? "\nChaque projet a son chat, et rien ne passe de l'un à l'autre." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
