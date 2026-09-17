// Ce qu'un shell ouvert par l'application donne à un agent lancé à la main.
//
// Le panneau d'agent branche `claude` et `codex` lui-même. Un agent démarré au
// clavier dans le terminal intégré, lui, n'a aucun moyen de deviner sur quel
// port le démon de ce projet écoute ni quel jeton l'ouvre : les deux changent à
// chaque démarrage. C'est ce branchement-là qu'on exerce ici.
//
// Ce qui casse en silence :
//
// 1. **Le lanceur qui perd ses arguments.** `zyvro-mcp claude --model x` doit
//    arriver à claude avec `--model x` *et* la configuration. Un script qui
//    oublie `"$@"` démarre un agent qui a l'air normal et qui ignore ce qu'on
//    lui a demandé. Alors on le lance vraiment, contre un faux binaire qui
//    répète ce qu'il a reçu.
//
// 2. **Deux listes de serveurs.** Le fichier `mcp.json`, les `-c` de codex et
//    les variables d'environnement décrivent les mêmes serveurs. Si elles ne
//    viennent pas de la même liste, ajouter un serveur en branche deux sur
//    trois, et le troisième ne dit rien.
//
// 3. **Un jeton qui traîne.** Le fichier porte le jeton du démon : propriétaire
//    seul, hors du projet — `.zyvro/` est fait pour être commité — et effacé
//    quand le shell se termine.
//
//     node scripts/check-shell-mcp.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-shell-mcp-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {}, BrowserWindow: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/main/mcp").replace(/\\/g, "/")}"\n` +
    `export { startShotsServer } from "${path.join(ROOT, "src/main/shots").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const mcp = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Le serveur de capture doit tourner : c'est lui qui donne son adresse et son
// jeton au second serveur, et un serveur qui écoute sans être déclaré est un
// outil que l'agent n'a pas.
const handle = await mcp.startShotsServer(() => [])
const ctx = { daemonOrigin: "http://127.0.0.1:4123", daemonToken: "jeton-moteur" }

// ---- sans projet, rien ---------------------------------------------------
{
  check("**un shell sans projet ouvert ne porte aucun jeton**", mcp.shellMcp({}) === null)
}

const shell = mcp.shellMcp(ctx)

// ---- ce que le shell porte ----------------------------------------------
{
  check("l'adresse du moteur est dans l'environnement", shell.env.ZYVRO_MCP_URL === "http://127.0.0.1:4123/mcp", shell.env.ZYVRO_MCP_URL)
  check("son jeton aussi", shell.env.ZYVRO_MCP_TOKEN === "jeton-moteur")
  check("la capture porte les siens", shell.env.ZYVRO_SHOTS_URL === handle.origin && shell.env.ZYVRO_SHOTS_TOKEN === handle.token)
  check("le fichier de configuration est nommé", Boolean(shell.env.ZYVRO_MCP_CONFIG))
  check(
    "**le lanceur est sur le PATH**",
    shell.env.PATH.split(path.delimiter)[0] === path.dirname(shell.env.ZYVRO_MCP_CONFIG),
    shell.env.PATH.split(path.delimiter)[0]
  )
  check("et le PATH de la machine est toujours derrière", shell.env.PATH.includes(process.env.PATH))
  check("le bandeau dit quoi taper", shell.banner.includes("zyvro-mcp claude") && shell.banner.includes("zyvro-mcp codex"), shell.banner)
  // En anglais, comme le reste de ce que la personne lit : les commentaires de
  // ce dépôt sont en français, l'interface ne l'est pas. Le bandeau était le
  // seul endroit où les deux s'étaient mélangés.
  check(
    "**et il le dit dans la langue de l'application**",
    !/[éèêàçù]/.test(shell.banner),
    shell.banner
  )
}

// ---- le fichier ----------------------------------------------------------
{
  const file = shell.env.ZYVRO_MCP_CONFIG
  const written = JSON.parse(readFileSync(file, "utf8"))
  const names = Object.keys(written.mcpServers)
  check("**la configuration nomme les deux serveurs**", names.includes("zyvro") && names.includes("zyvro-app"), names.join(", "))
  check("le moteur garde son jeton", written.mcpServers.zyvro.headers.Authorization === "Bearer jeton-moteur")
  check("la capture le sien", written.mcpServers["zyvro-app"].headers.Authorization === `Bearer ${handle.token}`)
  // 0600 : le fichier porte un jeton, et /tmp est lisible par tout le monde.
  check("**lisible par son seul propriétaire**", (statSync(file).mode & 0o077) === 0, (statSync(file).mode & 0o777).toString(8))
  check(
    "**écrit hors du projet** (.zyvro/ est fait pour être commité)",
    !path.resolve(file).startsWith(path.resolve(ROOT)),
    file
  )
  // La même liste des deux côtés : le panneau d'agent et le shell.
  const panel = JSON.parse(readFileSync(mcp.writeMcpConfig(ctx).path, "utf8"))
  check(
    "**le panneau et le shell déclarent les mêmes serveurs**",
    JSON.stringify(Object.keys(panel.mcpServers)) === JSON.stringify(names)
  )
}

// ---- le lanceur, pour de vrai -------------------------------------------
//
// Un faux `claude` et un faux `codex` qui ne font qu'écrire ce qu'on leur a
// passé : c'est la seule façon de voir qu'un argument est arrivé.
if (process.platform !== "win32") {
  const fake = path.join(dir, "bin")
  mkdirSync(fake, { recursive: true })
  for (const name of ["claude", "codex"]) {
    const file = path.join(fake, name)
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o755 })
  }
  const helper = path.join(path.dirname(shell.env.ZYVRO_MCP_CONFIG), "zyvro-mcp")
  check("le lanceur est exécutable", (statSync(helper).mode & 0o100) !== 0)

  const run = (...args) =>
    execFileSync("/bin/sh", [helper, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...shell.env, PATH: `${fake}${path.delimiter}${shell.env.PATH}` },
    })

  {
    const out = run("claude", "--model", "opus").split("\n")
    check(
      "**claude part avec la configuration du projet**",
      out.includes("--mcp-config") && out.includes(shell.env.ZYVRO_MCP_CONFIG),
      out.join(" ")
    )
    // Sans lui, les serveurs MCP déclarés ailleurs par la personne s'ajoutent,
    // et l'agent n'a pas les mêmes outils d'une machine à l'autre.
    check("et seulement celle du projet", out.includes("--strict-mcp-config"))
    check("**ce qu'on tape derrière arrive**", out.includes("--model") && out.includes("opus"), out.join(" "))
  }

  {
    const out = run("codex", "exec", "bonjour").split("\n")
    check(
      "**codex part avec l'adresse du moteur**",
      out.includes(`mcp_servers.zyvro.url="http://127.0.0.1:4123/mcp"`),
      out.join(" ")
    )
    check(
      "et va chercher le jeton dans l'environnement, pas sur la ligne de commande",
      out.includes(`mcp_servers.zyvro.bearer_token_env_var="ZYVRO_MCP_TOKEN"`) &&
        !out.some((line) => line.includes("jeton-moteur")),
      out.join(" ")
    )
    check("la capture est déclarée aussi", out.includes(`mcp_servers.zyvro-app.url="${handle.origin}"`))
    check("**ce qu'on tape derrière arrive**", out.includes("exec") && out.includes("bonjour"), out.join(" "))
  }

  {
    const out = run()
    check("**seul, il dit tout ce qu'il y a**", out.includes("http://127.0.0.1:4123/mcp") && out.includes(shell.env.ZYVRO_MCP_CONFIG), out)
    check("en anglais lui aussi", !/[éèêàçù]/.test(out), out)
    check("y compris le serveur de capture", out.includes(handle.origin), out)
  }
}

// ---- la durée de vie du jeton -------------------------------------------
{
  const file = shell.env.ZYVRO_MCP_CONFIG
  shell.dispose()
  check("**le jeton ne survit pas au shell**", !existsSync(file), file)
}

console.log(
  failures === 0
    ? "\nUn shell ouvert par l'application sait où est le MCP du projet, et un agent lancé dedans l'a."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
