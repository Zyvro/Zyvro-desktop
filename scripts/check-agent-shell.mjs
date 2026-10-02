// Le même harnais, mais dans son interface à lui.
//
// Le panneau lance ces CLI en mode impression — `claude -p`, `codex exec` — et
// redessine leur flux JSON. C'est ce qu'il faut pour tenir une conversation
// dans une fenêtre qui est la nôtre, et ça reste une conversation redessinée.
// Ces programmes ont leur propre interface, elle est bonne, et certaines
// personnes la préfèrent. Ce bouton ouvre un shell et la lance dedans.
//
// Ce qui casse en silence ici :
//
// 1. **Les drapeaux du mode impression qui suivent.** `-p`, `--output-format
//    stream-json`, `exec` : donnés à une session interactive, ils rendent
//    exactement ce qu'on essayait de quitter — un tour qui répond une fois et
//    s'en va, ou du JSON qui défile. Le bouton n'aurait servi à rien, et rien
//    ne le dirait.
//
// 2. **La visée perdue en route.** On choisit « ollama-local/gemma3:4b » dans
//    le menu, on clique, et le shell part sur l'abonnement du harnais avec un
//    nom de modèle qu'il ne connaît pas. La CLI répond « unrecognized model »
//    ou, pire, répond tout court — depuis le mauvais compte.
//
// 3. **La clef sur la ligne de commande.** `ps` est lisible par tout ce qui
//    tourne sur la machine. C'est la règle de ce dépôt depuis que la question
//    de l'agent part sur stdin, et un shell n'y échappe pas.
//
// 4. **Le rendu qui choisit ce qu'on lance.** « Ouvre ce harnais » ne doit pas
//    pouvoir devenir « lance cet exécutable ».
//
//     node scripts/check-agent-shell.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-agent-shell-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export { shellArgsFor, argsFor, claudeAimEnv, aimEnv, GATEWAY_KEY_VAR, SHELL_YOLO } from "${from("src/main/agent")}"\n` +
    `export { AGENT_KINDS, harness } from "${from("src/shared/harness")}"\n`
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

const secret = { provider: "custom", url: "https://exemple.test/v1", key: "sk-tres-secrete", model: "m" }
const vise = { baseUrl: "http://127.0.0.1:1234/v1", keyVar: mod.GATEWAY_KEY_VAR }

// ---- rien du mode impression --------------------------------------------
{
  // Les drapeaux qui font parler ces CLI à un programme plutôt qu'à quelqu'un.
  const IMPRESSION = ["-p", "--output-format", "stream-json", "--append-system-prompt", "exec", "--bare", "-o"]
  for (const kind of mod.AGENT_KINDS) {
    const ligne = mod.shellArgsFor(kind, "lmstudio/m", null, null)
    const fautif = IMPRESSION.filter((flag) => ligne.includes(flag))
    check(
      `**${kind} s'ouvre dans son interface, pas en mode impression**`,
      fautif.length === 0,
      `${ligne.join(" ")} — ${fautif.join(", ")}`
    )
  }
  // Et la preuve par l'autre côté : le mode impression, lui, les porte bien.
  // Sans ça le test ci-dessus passerait pour une liste de drapeaux périmée.
  const ctx = { projectDir: "/tmp/projet", workflows: [], permission: "project" }
  check(
    "et le panneau, lui, les emploie toujours",
    mod.argsFor("claude", ctx, null, null).includes("-p"),
    "la liste de drapeaux surveillée ne correspond plus à rien"
  )
}

// ---- le shell part en YOLO -----------------------------------------------
{
  // Le bouton sert à confier un projet entier à un agent : une CLI qui
  // s'arrête à chaque commande pour demander n'y sert à rien.
  const CLAUDE_YOLO = "--permission-mode=bypassPermissions --allow-dangerously-skip-permissions"
  const CODEX_YOLO = '-c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox'
  for (const model of [null, "opus", "custom/m"]) {
    const a = mod.shellArgsFor("claude", model, model === "custom/m" ? secret : null, vise).join(" ")
    check(`**claude s'ouvre sans demander de permission** (${model ?? "sans modèle"})`, a.startsWith(CLAUDE_YOLO), a)
    const c = mod.shellArgsFor("codex", model, model === "custom/m" ? secret : null, vise).join(" ")
    check(`**codex aussi, en raisonnement haut** (${model ?? "sans modèle"})`, c.startsWith(CODEX_YOLO), c)
  }
  // Les guillemets doubles sont du TOML pour `-c`, pas du shell : sans eux
  // codex lit `high` comme une clef nue et refuse la valeur.
  check("la valeur de `-c` garde ses guillemets TOML", mod.SHELL_YOLO.codex.includes('model_reasoning_effort="high"'))
  // Et le panneau, lui, garde la permission qu'on lui a choisie.
  const ctx = { projectDir: "/tmp/projet", workflows: [], permission: "project" }
  const tour = mod.argsFor("claude", ctx, null, null).join(" ")
  check("le mode YOLO ne déborde pas sur les tours du panneau", !tour.includes("bypassPermissions"), tour)
}

// ---- le modèle choisi part avec ------------------------------------------
{
  const CLAUDE_YOLO = mod.SHELL_YOLO.claude.join(" ")
  const CODEX_YOLO = mod.SHELL_YOLO.codex.join(" ")
  check("**claude emporte son modèle**", mod.shellArgsFor("claude", "opus").join(" ") === `${CLAUDE_YOLO} --model opus`)
  check("**qwen emporte le sien**", mod.shellArgsFor("qwen", "q3").join(" ") === "-m q3")
  check("**codex aussi**", mod.shellArgsFor("codex", "gpt").join(" ") === `${CODEX_YOLO} --model gpt`)
  // Un modèle vide n'est pas un modèle : `--model ""` est refusé par la CLI,
  // et la personne voit un échec pour une case qu'elle a simplement laissée.
  for (const kind of mod.AGENT_KINDS) {
    const ligne = mod.shellArgsFor(kind, "  ")
    check(`sans modèle, ${kind} n'en invente pas`, !ligne.includes("--model") && !ligne.includes("-m"), ligne.join(" "))
  }
}

// ---- la visée arrive jusqu'au shell --------------------------------------
{
  const q = mod.shellArgsFor("qwen", "custom/m", secret).join(" ")
  check("**qwen visé reçoit son type d'authentification**", q.includes("--auth-type openai") && q.includes("-m m"), q)

  const c = mod.shellArgsFor("codex", "custom/m", secret, vise).join(" ")
  check("**codex visé passe par la passerelle**", c.includes("model_provider=zyvro"), c)
  check("et elle est déclarée avec son adresse", c.includes(vise.baseUrl), c)

  // claude ne prend aucun drapeau d'adresse : la sienne est dans
  // l'environnement, et son modèle EST la route de la passerelle.
  const a = mod.shellArgsFor("claude", "custom/m", secret, vise).join(" ")
  check("**claude visé garde la route dans `--model`**", a === `${mod.SHELL_YOLO.claude.join(" ")} --model custom/m`, a)
}

// ---- et la clef ne passe jamais par la ligne -----------------------------
{
  for (const kind of mod.AGENT_KINDS) {
    const ligne = mod.shellArgsFor(kind, "custom/m", secret, vise).join(" ")
    check(
      `**la clef de ${kind} n'est pas dans \`ps\`**`,
      !ligne.includes(secret.key) && !ligne.includes(secret.url),
      ligne
    )
  }
  // Là où elle passe : l'environnement, que le pty reçoit avec sa commande.
  const term = readFileSync(path.join(ROOT, "src/main/terminal.ts"), "utf8")
  check(
    "**la commande d'un pty porte son environnement**",
    /\.\.\.command\?\.env/.test(term),
    "sans ça il ne reste que la ligne de commande, qui est publique"
  )
  check("et il vient en dernier, donc il gagne", /\.\.\.extra, \.\.\.command\?\.env/.test(term))
}

// ---- ce que la fenêtre a le droit de demander ----------------------------
{
  const ipc = readFileSync(path.join(ROOT, "src/main/ipc.ts"), "utf8")
  const bloc = ipc.slice(ipc.indexOf('ipcMain.handle("agent:shell"'), ipc.indexOf('ipcMain.handle("agent:unschedule"'))
  check("**le harnais reçu est vérifié**", /if \(!isAgentKind\(kind\)\)/.test(bloc), "« lance ce harnais » deviendrait « lance ce que je veux »")
  check(
    "**et c'est la table des harnais qui nomme l'exécutable**",
    /harness\(kind\)/.test(bloc) && /locate\(table\.bin\)/.test(bloc),
    "le rendu choisirait ce qui se lance"
  )
  check(
    "**un harnais absent le dit avec la commande pour l'installer**",
    /was not found on this machine\. Install it with: \$\{table\.install\}/.test(bloc),
    "« not found » sans dire par où commencer oblige à chercher ailleurs"
  )
  check(
    "**le shell part dans le dossier du projet, avec ses serveurs MCP**",
    /requireRoot\(ws\)/.test(bloc) && /daemonToken: ws\.daemon\.current\?\.token/.test(bloc),
    "un harnais sans les outils du projet est un harnais qu'on relance à la main"
  )

  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  check(
    "**et le panneau du bas s'ouvre pour qu'on voie ce qu'on a demandé**",
    /setPanel\("terminal", true\)[\s\S]{0,200}?askHarness\(kind, thread\.model\)/.test(panel),
    "le clic ne fait rien quand le terminal est replié, et part tout seul plus tard"
  )
}

console.log(
  failures === 0
    ? "\nLe harnais s'ouvre dans son interface avec ce que le panneau lui aurait donné, et sa clef reste hors de `ps`."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
