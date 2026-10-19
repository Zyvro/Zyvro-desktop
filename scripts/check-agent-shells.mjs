// Shell + Agents : un agent est un shell dont le programme est un harnais.
//
// Le panneau d'agent redessinait le flux de `claude -p`, et on finissait par
// ouvrir l'interface native du harnais dans le terminal, sans rien de ce qu'on
// avait réglé dans le panneau. Ces vérifications tiennent la traduction d'une
// configuration (harnais, modèle, permission, effort, instructions, outils) en
// ligne de commande native, et la garde des sessions pour les rouvrir.
//
// Ce qui casse en silence ici :
//
// 1. **Un drapeau du mode impression** (`-p`, `--output-format`, `exec`) donné à
//    une session interactive : elle répondrait une fois et s'en irait.
// 2. **Une tâche avalée.** `--mcp-config` et `--allowedTools` de claude sont
//    variadiques : sans `--`, ils prennent la tâche pour un de leurs arguments.
// 3. **Une reprise qui n'en est pas une.** `codex resume <id>` est une
//    sous-commande ; mal placé, l'identifiant devient le prompt.
// 4. **Une permission élargie.** « project » ne doit jamais lever la
//    protection, ni un niveau inconnu retomber sur le plus permissif.
// 5. **Un identifiant venu du disque** qui part sur une ligne de commande.
// 6. **Une session perdue.** Les enregistrements écrits ensemble s'écrasaient,
//    et un `--resume` sans journal fait quitter claude aussitôt.
// 7. **Un onglet qui meurt à la fermeture de l'application** et ne revient pas,
//    ou qui revient alors qu'on l'avait fermé.
//
//     node scripts/check-agent-shells.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-agent-shells-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/shared/agentShell")}"\n` +
    `export * as store from "${from("src/main/agentShells")}"\n` +
    `export { claudePermission, qwenPermission, mimoPermission, codexPermission } from "${from("src/main/agent")}"\n` +
    `export { AGENT_KINDS } from "${from("src/shared/harness")}"\n` +
    `export { PERMISSIONS } from "${from("src/shared/permission")}"\n` +
    `export { sanitizeAgentSettings, sanitizeSettings, DEFAULT_SETTINGS } from "${from("src/shared/settings")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const base = {
  model: null,
  permission: "project",
  effort: null,
  name: "",
  sessionId: null,
  assign: false,
  systemPrompt: "",
  mcpArgs: [],
  aimArgs: [],
  prompt: "",
}
const line = (kind, over = {}) => mod.nativeArgs({ ...base, kind, ...over })

// ---- rien du mode impression --------------------------------------------
{
  const IMPRESSION = ["-p", "--print", "--output-format", "stream-json", "--input-format", "exec", "--bare", "-o", "--json", "--skip-git-repo-check", "--replay-user-messages", "--verbose"]
  for (const kind of mod.AGENT_KINDS) {
    for (const permission of mod.PERMISSIONS) {
      const ligne = line(kind, { permission, model: "m", prompt: "tâche", sessionId: "abc-123", effort: "high" })
      const fautif = IMPRESSION.filter((flag) => ligne.includes(flag))
      check(`**${kind}/${permission} s'ouvre dans son interface, pas en mode impression**`, fautif.length === 0, `${ligne.join(" ")} — ${fautif.join(", ")}`)
    }
  }
}

// ---- la permission -------------------------------------------------------
{
  // « project » ne lève jamais la protection, chez aucun harnais.
  const LEVEES = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--permission-mode=bypassPermissions", "yolo", "bypassPermissions", "danger-full-access", "--allow-dangerously-skip-permissions"]
  for (const kind of mod.AGENT_KINDS) {
    for (const permission of ["read", "ask", "project"]) {
      const ligne = line(kind, { permission }).join(" ")
      const fautif = LEVEES.filter((m) => ligne.includes(m))
      check(`**${kind}/${permission} ne lève pas la protection**`, fautif.length === 0, `${ligne} — ${fautif.join(", ")}`)
    }
  }
  check("claude project : acceptEdits, le mode qui garde le projet", line("claude").join(" ").includes("--permission-mode acceptEdits"))
  check("claude read : le mode plan", line("claude", { permission: "read" }).join(" ").includes("--permission-mode plan"))
  check("claude ask : le mode qui demande", line("claude", { permission: "ask" }).join(" ").includes("--permission-mode manual"))
  check("claude yolo : tout levé, comme le bouton d'avant", line("claude", { permission: "yolo" }).join(" ").includes("bypassPermissions"))
  check("codex read : bac à sable en lecture seule", line("codex", { permission: "read" }).join(" ").includes("sandbox_mode=read-only"))
  check("codex project : le projet, sans demander", line("codex").join(" ").includes("sandbox_mode=workspace-write") && line("codex").join(" ").includes("approval_policy=never"))
  check("codex ask : il demande", line("codex", { permission: "ask" }).join(" ").includes("approval_policy=untrusted"))
  check("codex yolo : l'unique drapeau qui lève tout", line("codex", { permission: "yolo" }).includes("--dangerously-bypass-approvals-and-sandbox"))
  check("un niveau inconnu retombe sur le défaut, pas sur yolo", mod.sanitizeSpec({ kind: "claude", permission: "root" }).permission === "project")
  // Les mêmes niveaux que le mode impression chez qwen et mimo, qui n'ont pas
  // de variante qui ne demande à personne : si l'un change, l'autre le suit.
  for (const permission of mod.PERMISSIONS) {
    check(`qwen/${permission} dit comme le panneau`, mod.nativePermission("qwen", permission).join(" ") === mod.qwenPermission(permission, permission === "ask").join(" ") || permission === "ask")
    if (permission !== "yolo") {
      check(`mimo/${permission} dit comme le panneau`, mod.nativePermission("mimo", permission).join(" ") === mod.mimoPermission(permission).join(" "))
    }
  }
  check("claude project : le même mode que le panneau", mod.claudePermission("project").includes("acceptEdits") && mod.nativePermission("claude", "project").includes("acceptEdits"))
  check("codex : même sandbox que le panneau", ["read", "project"].every((p) => mod.codexPermission(p).join(" ").includes(p === "read" ? "read-only" : "workspace-write")))
}

// ---- claude : session, tâche, outils ----------------------------------------
{
  const neuve = line("claude", { sessionId: "11111111-2222-3333-4444-555555555555", assign: true })
  check("**claude : une session neuve reçoit son identifiant dès le départ**", neuve.join(" ").includes("--session-id 11111111-2222-3333-4444-555555555555") && !neuve.includes("--resume"))
  const reprise = line("claude", { sessionId: "abc-123", assign: false })
  check("**claude : une reprise passe par --resume**", reprise.join(" ").includes("--resume abc-123") && !reprise.includes("--session-id"))

  const ligne = line("claude", {
    prompt: "fais ceci\nsur deux lignes \"avec guillemets\"",
    mcpArgs: ["--mcp-config", "/tmp/m.json", "--allowedTools", "mcp__zyvro,mcp__zyvro-app"],
    systemPrompt: "préambule",
    model: "sonnet",
    effort: "xhigh",
    name: "ma session",
  })
  check("**claude : la tâche est le dernier mot, séparée par --**", ligne.at(-1) === "fais ceci\nsur deux lignes \"avec guillemets\"" && ligne.at(-2) === "--", ligne.join("|"))
  check("**claude : les options variadiques sont avant le --**", ligne.indexOf("--mcp-config") < ligne.indexOf("--") && ligne.indexOf("--allowedTools") < ligne.indexOf("--"))
  check("claude : modèle, effort, nom, prompt système", ligne.includes("--model") && ligne.includes("sonnet") && ligne.join(" ").includes("--effort xhigh") && ligne.includes("--name") && ligne.includes("--append-system-prompt") && ligne.includes("préambule"))
  check("claude sans tâche : pas de -- orphelin", !line("claude").includes("--"))
  check("claude sans modèle n'en invente pas", !line("claude").includes("--model"))
  const sansMcp = line("claude", { prompt: "x" })
  check("claude : sans MCP, aucune option variadique", !sansMcp.includes("--mcp-config") && !sansMcp.includes("--allowedTools"))
}

// ---- codex : la reprise est une sous-commande ------------------------------
{
  const reprise = line("codex", { sessionId: "abc-123", prompt: "suite" })
  check("**codex : `resume` d'abord, l'identifiant puis la tâche**", reprise[0] === "resume" && reprise.at(-2) === "abc-123" && reprise.at(-1) === "suite", reprise.join(" "))
  const neuve = line("codex", { prompt: "go", model: "gpt-x", effort: "max" })
  check("codex neuve : pas de resume", neuve[0] !== "resume")
  check("codex : l'effort est plafonné à ce qu'il accepte", neuve.join(" ").includes("model_reasoning_effort=high") && !neuve.join(" ").includes("=max"))
  check("codex : la tâche finit la ligne", neuve.at(-1) === "go")
  check("codex : une tâche qui commence par un tiret reste une tâche", line("codex", { prompt: "-rf /" }).slice(-2).join("|") === "--|-rf /")
  check("codex : modèle", neuve.join(" ").includes("--model gpt-x"))
  const mcp = line("codex", { mcpArgs: ["-c", 'mcp_servers.zyvro.url="http://x"'], aimArgs: ["-c", "model_provider=zyvro"], sessionId: "s1" })
  check("codex : MCP et visée avant l'identifiant", mcp.indexOf("s1") > mcp.lastIndexOf('mcp_servers.zyvro.url="http://x"') && mcp.indexOf("s1") > mcp.lastIndexOf("model_provider=zyvro"))
}

// ---- qwen et mimo --------------------------------------------------------
{
  check("qwen : reprise par --resume", line("qwen", { sessionId: "q-1" }).join(" ").includes("--resume q-1"))
  check("qwen : sa tâche ne voyage pas en argument (collée dans l'invite)", !line("qwen", { prompt: "x" }).includes("x") && mod.promptDelivery("qwen") === "paste")
  check("qwen visé : la visée remplace -m", !line("qwen", { aimArgs: ["--auth-type", "openai"], model: "m" }).includes("-m"))
  check("qwen sans visée : -m", line("qwen", { model: "m" }).join(" ").includes("-m m"))
  check("mimo : reprise par --session", line("mimo", { sessionId: "ses_abc" }).join(" ").includes("--session ses_abc"))
  check("mimo : modèle", line("mimo", { model: "x/y" }).join(" ").includes("--model x/y"))
  check("la livraison : argv pour claude et codex seulement", mod.AGENT_KINDS.filter((k) => mod.promptDelivery(k) === "argv").join() === "claude,codex")
  check("effort : claude et codex seulement", mod.AGENT_KINDS.filter(mod.supportsEffort).join() === "claude,codex")
  check("qwen/mimo ignorent l'effort même demandé", mod.sanitizeSpec({ kind: "qwen", effort: "high" }).effort === null)
}

// ---- les identifiants ------------------------------------------------------
{
  for (const mauvais of ["a b", "x;rm -rf /", "$(id)", "../../etc", "", "a\nb", "é", "x".repeat(101)]) {
    const reprise = line("claude", { sessionId: mauvais })
    check(`**un identifiant douteux ne part pas en argument** (${JSON.stringify(mauvais).slice(0, 24)})`, !reprise.includes(mauvais) || mauvais === "")
  }
  check("un identifiant sain passe", line("claude", { sessionId: "abc_DEF-123" }).includes("abc_DEF-123"))
  check("sessionIdOk refuse un espace", !mod.sessionIdOk("a b") && mod.sessionIdOk("ses_Abc-1"))
}

// ---- tâche et préambule ------------------------------------------------------
{
  check("claude a un prompt système : la tâche reste telle quelle", mod.taskText("claude", "PRE", "tâche") === "tâche")
  check("codex n'en a pas : le préambule ouvre la tâche", mod.taskText("codex", "PRE", "tâche").startsWith("PRE") && mod.taskText("codex", "PRE", "tâche").endsWith("tâche"))
  check("sans tâche, rien n'est collé", mod.taskText("codex", "PRE", "") === "")
  const colle = mod.bracketedPaste("a\r\nb\x1b[201~INJECTÉ")
  check("**le collage ne peut pas se refermer de l'intérieur**", colle.startsWith("\x1b[200~") && colle.endsWith("\x1b[201~") && colle.indexOf("\x1b[201~") === colle.length - 6)
  check("le collage ne finit pas par Entrée : on relit avant d'envoyer", !/[\r\n]$/.test(colle))
}

// ---- profils et demandes -----------------------------------------------------
{
  const brut = mod.sanitizeProfiles([
    { id: "a", name: "  ", kind: "claude", permission: "yolo", effort: "high", mcp: false },
    { id: "a", name: "doublon", kind: "codex", permission: "nimporte" },
    { id: "../x", name: "id douteux", kind: "qwen", effort: "high" },
    { name: "inconnu", kind: "gpt" },
    "pas un objet",
  ])
  check("un profil sans nom prend le nom du harnais", brut[0].name === "claude")
  check("un identifiant en double est renuméroté", new Set(brut.map((p) => p.id)).size === brut.length)
  check("un profil à harnais inconnu est écarté", brut.length === 3)
  check("une permission inconnue retombe sur le défaut", brut[1].permission === "project")
  check("l'effort est retiré d'un harnais qui ne le prend pas", brut[2].effort === null)
  check("un identifiant douteux est remplacé", /^[A-Za-z0-9_-]+$/.test(brut[2].id))
  check("`mcp: false` est respecté", brut[0].mcp === false)
  check("une liste vide redonne un profil par harnais", mod.sanitizeProfiles([]).length === mod.AGENT_KINDS.length)
  check("une valeur qui n'est pas une liste aussi", mod.sanitizeProfiles("x").length === mod.AGENT_KINDS.length)
  check("jamais plus de 24 profils", mod.sanitizeProfiles(Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, kind: "claude" }))).length === 24)

  const spec = mod.sanitizeSpec({ kind: "claude", prompt: "x".repeat(50_000), name: "a\nb\tc", resume: "../x", conversation: 5, instructions: 3 })
  check("une tâche démesurée est bornée", spec.prompt.length === 40_000)
  check("un nom n'a ni retour à la ligne ni tabulation", spec.name === "a b c")
  check("un enregistrement à reprendre mal formé est ignoré", spec.resume === null)
  check("une conversation qui n'est pas du texte est ignorée", spec.conversation === null)
  check("un harnais inconnu n'est pas une demande", mod.sanitizeSpec({ kind: "rm" }) === null && mod.sanitizeSpec(null) === null)

  const reglages = mod.sanitizeAgentSettings({ profiles: [{ id: "z", kind: "codex" }], defaultProfile: "absent" })
  check("**le profil par défaut doit exister**", reglages.defaultProfile === null)
  check("réglages d'avant : des profils par défaut et la reprise allumée", mod.sanitizeAgentSettings({}).profiles.length === mod.AGENT_KINDS.length && mod.sanitizeAgentSettings({}).restoreAgentShells === true)
  check("la reprise au démarrage peut s'éteindre", mod.sanitizeAgentSettings({ restoreAgentShells: false }).restoreAgentShells === false)
  check("les réglages sains se relisent à l'identique", JSON.stringify(mod.sanitizeSettings(mod.sanitizeSettings({}))) === JSON.stringify(mod.sanitizeSettings({})))
}

// ---- les enregistrements --------------------------------------------------------
{
  const r = (id, over = {}) => ({ id, kind: "claude", state: "closed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", ...over })
  const liste = mod.sanitizeRecords([r("a"), r("a"), r("b", { sessionId: "bad id" }), { kind: "claude" }, r("c", { kind: "nope" })])
  check("doublons, sans identifiant et harnais inconnu écartés", liste.map((x) => x.id).sort().join() === "a,b")
  check("**un identifiant de session douteux est effacé du disque**", liste.find((x) => x.id === "b").sessionId === null)
  check("un état inconnu vaut « fermé » : rien ne se rouvre par erreur", mod.sanitizeRecord(r("a", { state: "bizarre" })).state === "closed")
  check("du plus récent au plus ancien", mod.sanitizeRecords([r("old", { updatedAt: "2026-01-01T00:00:00Z" }), r("new", { updatedAt: "2026-03-01T00:00:00Z" })])[0].id === "new")

  const ouvertes = [r("1", { state: "open", createdAt: "2026-01-01T00:00:00Z" }), r("2", { state: "closed" }), r("3", { state: "open", createdAt: "2026-01-03T00:00:00Z" }), r("4", { state: "open", createdAt: "2026-01-02T00:00:00Z" })].map(mod.sanitizeRecord)
  check("**on rouvre ce qui était ouvert, pas ce qui était fermé**", mod.toRestore(ouvertes, new Set()).map((x) => x.id).join() === "1,4,3")
  check("**et pas ce qui tourne déjà**", mod.toRestore(ouvertes, new Set(["4"])).map((x) => x.id).join() === "1,3")
  check("avec une borne", mod.toRestore(ouvertes, new Set(), 2).length === 2 && mod.toRestore(ouvertes, new Set(), 0).length === 0)

  check("titre : le nom choisi d'abord", mod.recordTitle({ name: "mon agent", prompt: "x", kind: "claude", model: null }) === "mon agent")
  check("titre : sinon la tâche", mod.recordTitle({ name: "", prompt: "\n  corrige   le bug\nsuite", kind: "claude", model: null }) === "corrige le bug")
  check("titre : sinon le harnais et le modèle", mod.recordTitle({ name: "", prompt: "", kind: "codex", model: "gpt-x" }) === "codex · gpt-x")
  check("titre : une longue tâche est coupée", mod.recordTitle({ name: "", prompt: "x".repeat(80), kind: "claude", model: null }).length === 40)
}

// ---- retrouver la session de codex --------------------------------------------------
{
  const meta = (id, cwd) => JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id, cwd } })
  check("codex : l'identifiant vient de session_meta", mod.codexSessionFromMeta(meta("019a-bc", "/p"), "/p") === "019a-bc")
  check("codex : une autre racine n'est pas la nôtre", mod.codexSessionFromMeta(meta("019a-bc", "/autre"), "/p") === null)
  check("codex : Windows, casse et séparateurs ne comptent pas", mod.codexSessionFromMeta(meta("x1", "C:\\Users\\Moi\\Proj"), "c:/users/moi/proj/") === "x1")
  check("**codex : une première ligne coupée donne quand même l'identifiant**", mod.codexSessionFromMeta('{"type":"session_meta","payload":{"id":"cut-1","cwd":"/p","base_instructions":"aaaa', "/p") === "cut-1")
  check("codex : coupée, mais d'un autre dossier, elle n'est pas la nôtre", mod.codexSessionFromMeta('{"type":"session_meta","payload":{"id":"cut-1","cwd":"/ailleurs","base_instructions":"aaaa', "/p") === null)
  check("codex : une ligne abîmée n'est pas une session", mod.codexSessionFromMeta("{pas du json", "/p") === null && mod.codexSessionFromMeta("{}", "/p") === null)
  check("codex : un identifiant douteux est refusé", mod.codexSessionFromMeta(meta("a b;c", "/p"), "/p") === null)

  const home = mkdtempSync(path.join(tmpdir(), "zyvro-codex-"))
  try {
    const jour = path.join(home, "sessions", "2026", "10", "19")
    mkdirSync(jour, { recursive: true })
    const ancien = path.join(jour, "rollout-2026-10-19T08-00-00-old1.jsonl")
    const neuf = path.join(jour, "rollout-2026-10-19T09-00-00-new1.jsonl")
    const ailleurs = path.join(jour, "rollout-2026-10-19T09-00-01-away.jsonl")
    writeFileSync(ancien, meta("old1", "/p") + "\n")
    // Le vrai codex (0.163) écrit ses instructions de base sur la première ligne : ~21 Ko.
    const grosse = JSON.stringify({ type: "session_meta", payload: { id: "new1", cwd: "/p", base_instructions: "x".repeat(30_000) } })
    writeFileSync(neuf, grosse + "\n{\"suite\":1}\n")
    writeFileSync(ailleurs, meta("away", "/autre") + "\n")
    const t0 = Date.now()
    utimesSync(ancien, new Date(t0 - 3_600_000), new Date(t0 - 3_600_000))
    const env = { CODEX_HOME: home }
    check("**codex : le journal apparu après le lancement, dans ce dossier**", mod.store.findCodexSession("/p", t0 - 10_000, new Set(), env) === "new1")
    check("codex : pas celui d'avant le lancement", mod.store.findCodexSession("/p", t0 + 60_000, new Set(), env) === null)
    check("**codex : deux onglets ne se volent pas leur session**", mod.store.findCodexSession("/p", t0 - 10_000, new Set(["new1"]), env) === null)
    check("codex : pas la session d'un autre dossier", mod.store.findCodexSession("/vide", t0 - 10_000, new Set(), env) === null)
    check("codex : une session existante se reconnaît", mod.store.codexSessionExists("new1", env) && !mod.store.codexSessionExists("nope", env))
    check("codex : un identifiant douteux ne cherche rien", !mod.store.codexSessionExists("../x", env))
    const trouve = await new Promise((resolve) => {
      const stop = mod.store.watchCodexSession("/p", t0 - 10_000, () => new Set(), resolve, env, 20, 2000)
      setTimeout(() => stop(), 2500)
    })
    check("codex : le sondage rapporte la session trouvée", trouve === "new1")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  // Les journaux de codex ne sont pas toujours rangés par AAAA/MM/JJ : un lecteur qui
  // n'en accepte qu'à une profondeur donnée ne les voit plus, et la session semble perdue.
  {
    const racine = mkdtempSync(path.join(tmpdir(), "zyvro-codex-flat-"))
    try {
      const meta2 = (id) => JSON.stringify({ type: "session_meta", payload: { id, cwd: "/p" } }) + "\n"
      mkdirSync(path.join(racine, "sessions", "2026", "10"), { recursive: true })
      writeFileSync(path.join(racine, "sessions", "rollout-2026-10-19T09-00-00-plat.jsonl"), meta2("plat"))
      writeFileSync(path.join(racine, "sessions", "2026", "10", "rollout-2026-10-19T09-00-01-deux.jsonl"), meta2("deux"))
      const env2 = { CODEX_HOME: racine }
      check("**codex : un journal à la racine des sessions est vu**", mod.store.codexSessionExists("plat", env2))
      check("**codex : un journal à deux niveaux est vu**", mod.store.codexSessionExists("deux", env2))
      check("codex : et retrouvé par son dossier de travail", ["plat", "deux"].includes(mod.store.findCodexSession("/p", 0, new Set(), env2)))
      check("codex : le journal n'est pas pris pour celui d'un autre onglet", mod.store.findCodexSession("/p", 0, new Set(["plat", "deux"]), env2) === null)
    } finally {
      rmSync(racine, { recursive: true, force: true })
    }
  }

  const conf = mkdtempSync(path.join(tmpdir(), "zyvro-claude-"))
  try {
    mkdirSync(path.join(conf, "projects", "-home-moi-proj"), { recursive: true })
    writeFileSync(path.join(conf, "projects", "-home-moi-proj", "sess-1.jsonl"), "{}\n")
    const env = { CLAUDE_CONFIG_DIR: conf }
    check("**claude : un journal existant se reprend**", mod.store.claudeSessionExists("sess-1", env))
    check("**claude : sans journal, rien à reprendre (--resume ferait quitter la CLI)**", !mod.store.claudeSessionExists("sess-2", env))
    check("claude : un identifiant douteux ne cherche rien", !mod.store.claudeSessionExists("../projects/-home-moi-proj/sess-1", env))
  } finally {
    rmSync(conf, { recursive: true, force: true })
  }
}

// ---- changer de harnais : le transcript, et le briefing ---------------------------------
{
  const claudeLog = [
    { type: "summary", summary: "x" },
    { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" } },
    { type: "user", message: { role: "user", content: "Fix the login bug" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Looking at it." }, { type: "tool_use", name: "Bash", input: { command: "grep -r login src" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "src/a.ts:1: login" }] } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "SUBAGENT" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Fixed in src/a.ts." }, { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "text", text: "Now add a test" }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n{coupé"
  const turns = mod.parseTranscript("claude", claudeLog)
  check("claude : les paroles, dans l'ordre", turns.filter((t) => t.role !== "tool").map((t) => `${t.role}:${t.text}`).join("|") === "user:Fix the login bug|assistant:Looking at it.|assistant:Fixed in src/a.ts.|user:Now add a test", JSON.stringify(turns))
  check("claude : les outils en une ligne chacun", turns.filter((t) => t.role === "tool").map((t) => t.text).join("|") === "Bash: grep -r login src|Edit: src/a.ts")
  check("**claude : ni sous-agent, ni rappel, ni commande locale, ni résultat d'outil**", !JSON.stringify(turns).includes("SUBAGENT") && !JSON.stringify(turns).includes("command-name") && !JSON.stringify(turns).includes("src/a.ts:1"))
  check("une ligne abîmée n'arrête pas la lecture", turns.length === 6)

  const codexLog = [
    { type: "session_meta", payload: { id: "x", cwd: "/p" } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "SYSTEM" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls", "-la"] }) } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  ].map((o) => JSON.stringify(o)).join("\n")
  const c = mod.parseTranscript("codex", codexLog)
  check("codex : demande, outil, réponse ; sans contexte ni consigne système", c.map((t) => `${t.role}:${t.text}`).join("|") === "user:Refactor the parser|tool:shell: ls -la|assistant:Done.", JSON.stringify(c))
  check("un harnais sans journal lisible : aucun tour", mod.parseTranscript("qwen", claudeLog).length === 0 && mod.parseTranscript("mimo", codexLog).length === 0)

  const b = mod.briefing({ turns, from: { kind: "claude", model: "opus" }, to: { kind: "qwen", model: "ollama-local/glm-5.3:cloud" } })
  check("briefing : dit qui prend la suite de qui", b.includes("started with claude (opus)") && b.includes("you are qwen (ollama-local/glm-5.3:cloud)"))
  check("briefing : le fil est dedans, du plus ancien au plus récent", b.indexOf("Fix the login bug") < b.indexOf("Fixed in src/a.ts.") && b.indexOf("Fixed in src/a.ts.") < b.indexOf("Now add a test"))
  check("**briefing : demande de vérifier le dépôt avant de toucher à quoi que ce soit**", /git status/.test(b))
  const long = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `message ${i} ${"x".repeat(200)}` }))
  const bl = mod.briefing({ turns: long, from: { kind: "claude", model: null }, to: { kind: "codex", model: null }, budget: 6000 })
  check("**briefing : borné, et dit combien de messages sont laissés**", bl.length <= 6500 && /\[\d+ earlier messages? omitted\]/.test(bl), String(bl.length))
  check("briefing : garde la demande d'origine et la fin", bl.includes("Original request:") && bl.includes("message 0 ") && bl.includes("message 399"))
  check("briefing : sans transcript, il le dit et ne ment pas", /No transcript could be read/.test(mod.briefing({ turns: [], from: { kind: "qwen", model: null }, to: { kind: "claude", model: null } })))
  check("briefing : un nom de modèle n'ouvre pas de marqueur de collage", !mod.bracketedPaste(mod.briefing({ turns: [{ role: "user", text: "a\x1b[201~b" }], from: { kind: "claude", model: null }, to: { kind: "codex", model: null } })).slice(6, -6).includes("\x1b[201~"))

  check("une demande de relais nomme un enregistrement, pas autre chose", mod.sanitizeSpec({ kind: "codex", handoff: "../x" }).handoff === null && mod.sanitizeSpec({ kind: "codex", handoff: "abc-123" }).handoff === "abc-123")

  const dossier = mkdtempSync(path.join(tmpdir(), "zyvro-tr-"))
  try {
    mkdirSync(path.join(dossier, "claude", "projects", "-p"), { recursive: true })
    writeFileSync(path.join(dossier, "claude", "projects", "-p", "sess-9.jsonl"), claudeLog)
    mkdirSync(path.join(dossier, "codex", "sessions", "2026", "10", "19"), { recursive: true })
    writeFileSync(path.join(dossier, "codex", "sessions", "2026", "10", "19", "rollout-2026-10-19T09-00-00-cdx-1.jsonl"), codexLog)
    const env = { CLAUDE_CONFIG_DIR: path.join(dossier, "claude"), CODEX_HOME: path.join(dossier, "codex") }
    check("le journal de claude se retrouve par l'identifiant de session", mod.store.readTranscript("claude", "sess-9", env) === claudeLog)
    check("celui de codex aussi", mod.store.readTranscript("codex", "cdx-1", env) === codexLog)
    check("un harnais sans journal lisible rend null, sans lever", mod.store.readTranscript("qwen", "x", env) === null && mod.store.readTranscript("claude", "absent", env) === null)
    check("un identifiant douteux ne cherche rien", mod.store.readTranscript("claude", "../../etc/passwd", env) === null)
    writeFileSync(path.join(dossier, "claude", "projects", "-p", "big.jsonl"), "x".repeat(10) + "\n" + JSON.stringify({ type: "user", message: { content: "dernier" } }) + "\n")
    check("le journal est lu par la fin", mod.store.readTranscript("claude", "big", env).includes("dernier"))
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }

  const ipc2 = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  const panel2 = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  const dialog = readFileSync(path.join(ROOT, "src/renderer/panels/SwitchAgentDialog.tsx"), "utf8")
  check("**le relais lit le transcript de l'ancienne session côté principal**", /agentShells\.readTranscript\(source\.kind, source\.sessionId\)/.test(ipc2) && /spec\.handoff/.test(ipc2))
  check("**même harnais : l'agent est arrêté sans être noté « fermé », puis la session est rouverte**", /agentshell:switch/.test(ipc2) && /ws\.terminals\.dispose\(live\)/.test(ipc2) && /restartSession\(key\)/.test(panel2))
  check("**codex : un identifiant connu sans journal visible est quand même repris, pas jeté**", /trying to resume it anyway/.test(ipc2) && !/sessionId = null\n\s*\}/.test(ipc2.slice(ipc2.indexOf("speaksCodex(kind)) {"), ipc2.indexOf("trying to resume it anyway") + 80)))
  check("**codex : un identifiant jamais appris est retrouvé, à la reprise et avant de changer de modèle**", (ipc2.match(/findCodexSession\(root, Date\.parse\(/g) ?? []).length >= 2)
  check("autre harnais : seul le relais est permis", /const effective = same \? mode : "handoff"/.test(dialog))
  check("l'ancien agent s'arrête, sauf avis contraire", /choice\.stopCurrent && key\) panelActions\.close\(key\)/.test(panel2))
  check("le bouton est dans la barre d'onglets et dans la liste des sessions", /data-switch-agent/.test(panel2) && /askSwitch\(record\.id\)/.test(readFileSync(path.join(ROOT, "src/renderer/panels/AgentShellList.tsx"), "utf8")))
}

// ---- le disque ---------------------------------------------------------------------
{
  const dossier = mkdtempSync(path.join(tmpdir(), "zyvro-ash-"))
  try {
    const rec = (id, over = {}) => mod.sanitizeRecord({ id, kind: "claude", state: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over })
    const projet = path.join(dossier, "proj")
    const dir = path.join(dossier, "store")
    check("rien d'écrit : une liste vide", (await mod.store.load(dir, projet)).length === 0)
    await Promise.all(Array.from({ length: 25 }, (_, i) => mod.store.upsert(dir, projet, rec(`s${i}`))))
    check("**vingt-cinq écritures simultanées : aucune n'écrase les autres**", (await mod.store.load(dir, projet)).length === 25)
    await mod.store.patch(dir, projet, "s3", { state: "closed", sessionId: "abc-1", name: "x" })
    const s3 = (await mod.store.load(dir, projet)).find((x) => x.id === "s3")
    check("patch : état, identifiant et nom", s3.state === "closed" && s3.sessionId === "abc-1" && s3.name === "x")
    await mod.store.patch(dir, projet, "s3", { sessionId: "mauvais id!" })
    check("**patch : un identifiant douteux n'atteint pas le disque**", (await mod.store.load(dir, projet)).find((x) => x.id === "s3").sessionId === null)
    await mod.store.forget(dir, projet, "s4")
    check("forget", !(await mod.store.load(dir, projet)).some((x) => x.id === "s4"))
    check("un autre projet a sa propre liste", (await mod.store.load(dir, path.join(dossier, "autre"))).length === 0)
    writeFileSync(mod.store.fileFor(dir, projet), "{ coupé")
    check("un fichier abîmé est un historique vide, pas une fenêtre qui ne s'ouvre pas", (await mod.store.load(dir, projet)).length === 0)
    for (let i = 0; i < 230; i++) await mod.store.upsert(dir, projet, rec(`n${i}`))
    check("l'historique est borné", (await mod.store.load(dir, projet)).length === mod.MAX_RECORDS)
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
}

// ---- le câblage ---------------------------------------------------------------------
{
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  const terminal = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  const ouvrir = ipc.slice(ipc.indexOf('ipcMain.handle("agentshell:open"'), ipc.indexOf('ipcMain.handle("agentshell:list"'))

  check("**la demande de la fenêtre est vérifiée avant tout**", /sanitizeSpec\(rawSpec\)/.test(ouvrir) && /if \(!asked\) throw/.test(ouvrir))
  check("**une reprise relit la configuration sur le disque, pas dans la fenêtre**", /previous\.permission/.test(ouvrir) && /previous\.model/.test(ouvrir))
  check("**une session déjà ouverte est montrée, pas doublée**", /byAgentShell\(previous\.id\)/.test(ouvrir) && /existing: true/.test(ouvrir))
  check("claude : session neuve sans journal → --session-id, sinon --resume", /claudeSessionExists\(sessionId\)/.test(ouvrir) && /assign = true/.test(ouvrir))
  check("codex : l'identifiant est cherché quand on ne le connaît pas", /watchCodexSession\(/.test(ouvrir))
  check("la configuration MCP (un jeton) est effacée avec le shell", /cleanup: \(\) => \{\s*disposeMcp\(\)/.test(ouvrir))
  check("**la clef du fournisseur reste dans l'environnement, pas dans argv**", /harnessLaunch\(ws, kind, spec\.model\)/.test(ouvrir) && !/aim\.key/.test(ouvrir))
  check("le jeton du démon reste dans l'environnement de codex", /mcpTokenEnv\(target\)/.test(ouvrir))
  check("**sous cmd.exe, ni prompt système, ni nom, ni modèle libre sur la ligne**", /viaCmd \? "" : spec\.name/.test(ouvrir) && /hasSystemPromptFlag\(kind\) && !viaCmd/.test(ouvrir) && /cannot be passed to \$\{kind\} through cmd\.exe/.test(ouvrir))
  check("sous cmd.exe, la tâche ne passe en argument que si elle est sûre", /how\.shell \|\|/.test(ouvrir) || /!how\.shell \|\|/.test(ouvrir))
  check("et sinon elle est collée, jamais envoyée", /pasteWhenReady\(session\.id, bracketedPaste\(task\), 1500, 30_000, spec\.submit\)/.test(ouvrir))

  // L'arrêt de l'application ne ferme pas la session ; la croix de l'onglet, si.
  check("**fermer à la main prévient `onEnd`**", /close\(id: string[\s\S]{0,300}onEnd\?\.\("closed"\)/.test(terminal))
  check("**tuer au nom de l'arrêt (dispose) ne prévient pas**", /dispose\(id: string\): void \{\s*const session = this\.sessions\.get\(id\)\s*if \(session\) session\.ending = true/.test(terminal))
  check("la fin naturelle prévient, sauf si déjà décidée", /if \(fini && !fini\.ending\) fini\.onEnd\?\.\("exit", code\)/.test(terminal))
  check("la configuration MCP part à chaque fin de shell", /session\.cleanup\?\.\(\)/.test(terminal))
  check("la tâche n'est collée que dans le silence, sans Entrée", /pasteWhenReady[\s\S]{0,900}quietMs/.test(terminal))

  check("le panneau reprend la MÊME session après « Resume »", /agente: \{ spec: \{ \.\.\.agente\.spec, resume: session\.record\.id, prompt: "", submit: false \}/.test(panel))
  check("le panneau ne branche pas deux fois le même pty", /readStatus\(k\)\.agentRecord === ordre\.spec\.resume/.test(panel))
  check("les agents se rouvrent une fois par dossier", /restaureesPour\.has\(dir\)/.test(panel))
  check("et seulement si le réglage est allumé", /getSettings\(\)\.agent\.restoreAgentShells/.test(panel))
  check("les shells ordinaires ne se rouvrent pas", !/terminal\.restorable|shellRestorable/.test(panel))
}

// ---- la mise en page : Shell + Agents remplace la colonne Agent ----------------------
{
  const app = readFileSync(path.join(ROOT, "src/renderer/App.tsx"), "utf8")
  const rail = readFileSync(path.join(ROOT, "src/renderer/panels/ShellRail.tsx"), "utf8")
  const store = readFileSync(path.join(ROOT, "src/renderer/state/workspace.ts"), "utf8")
  const plugins = readFileSync(path.join(ROOT, "src/shared/plugins.ts"), "utf8")

  check("**la colonne Agent n'est plus montée**", !/<AgentPanel/.test(app) && !/from "~\/panels\/AgentPanel"/.test(app))
  check("**le Shell est monté UNE fois, dans un conteneur dont seule la direction change**",
    [...app.matchAll(/<TerminalPanel \/>/g)].length === 1 && /dock === "right" \? "flex-row" : "flex-col"/.test(app),
    "déplacer le composant le remonterait et tuerait les processus de ses onglets")
  check("masqué, jamais démonté", /!layout\.shell && "hidden"/.test(app) && /layout\.centre && "hidden"/.test(app))
  check("**mode IA : le Shell prend toute la fenêtre tant qu'aucun fichier n'est ouvert**", /return \{ shell: true, centre: !hasTabs \}/.test(app))
  check("**mode Dev : le code, et le Shell à droite ou en dessous**", /panels\.terminal \|\| panels\.agent/.test(app) && /dock === "right" \? \{ width: shellW \} : \{ height: shellH \}/.test(app))
  check("la séparation suit la position", /orientation=\{dock === "right" \? "vertical" : "horizontal"\}/.test(app))
  check("la barre latérale droite est là", /<ShellRail \/>/.test(app))
  check("le logo du projet y vit, déplaçable en haut ou en bas", /RailProject/.test(rail) && /setLogoPosition/.test(rail) && /position === "top" && logo/.test(rail) && /position === "bottom" && logo/.test(rail))
  check("on y choisit la position du Shell", /toggleShellDock/.test(rail))
  check("le terminal et l'agent sont un seul panneau", /if \(key === "terminal"\) next\.agent = open/.test(store) && /if \(key === "agent"\) next\.terminal = open/.test(store))
  check("**les plugins de la barre sont ceux qui ont un sens sans conversation**", /SHELL_PLUGINS: readonly PluginId\[\] = \["tasks", "memory", "permissions", "skills", "bugReport"\]/.test(plugins) && /only=\{SHELL_PLUGINS\}/.test(rail))
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/TerminalPanel.tsx"), "utf8")
  check("**la file de tâches prompte dans le shell : collé, puis Entrée**", /setTaskRunner\(\{/.test(panel) && /bracketedPaste\(task\.prompt\)/.test(panel) && /write\(ptyId, "\\r"\)/.test(panel))
  check("**« libre » se lit sur la sortie de tous les agents**", /idle: \(\) => agentTabs\(\)\.every\(\(t\) => !t\.ptyId \|\| t\.exitCode !== null \|\| !wrote\(t\.ptyId\)\)/.test(panel))
  check("sans agent vivant, un agent s'ouvre avec la tâche, envoyée seule", /askAgent\(\{ \.\.\.launcherSpec\(task\.prompt\), name: task\.title, submit: true \}, task\.id\)/.test(panel))
  check("une demande sans `submit` explicite ne s'envoie jamais seule", mod.sanitizeSpec({ kind: "qwen", prompt: "x" }).submit === false && mod.sanitizeSpec({ kind: "qwen", submit: true }).submit === true && mod.sanitizeSpec({ kind: "qwen", submit: "yes" }).submit === false)
  check("la permission de la barre règle le prochain agent, pas un réglage caché", /setPermission: \(permission\) => setLauncher\(\{ permission/.test(rail))
}

console.log(
  failures === 0
    ? "\nUn agent est un shell, avec tout ce qu'on a réglé, et sa session se rouvre."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
