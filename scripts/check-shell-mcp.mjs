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
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
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
  // Le fichier porte deux jetons, et ce qui le protège n'est pas la même chose
  // partout. Sur une machine Unix, /tmp est commun : le mode le dit. Sous
  // Windows, ces bits n'existent pas — Node n'en garde que le drapeau « lecture
  // seule » — et la protection vient du dossier temporaire, qui appartient à la
  // session. Vérifier le mode là-bas ferait échouer un garde sur une phrase
  // fausse ; ne rien vérifier laisserait le jeton sans surveillance. On vérifie
  // donc ce qui est vrai de chaque côté.
  if (process.platform === "win32") {
    // Comparés après `realpath`, et en minuscules : Windows rend volontiers le
    // nom court d'un dossier — `C:\Users\RUNNER~1\AppData\Local\Temp` — là où
    // le fichier porte le nom long. Deux façons d'écrire le même dossier, et
    // une comparaison littérale dirait qu'ils sont différents.
    const real = (p) => {
      try {
        return realpathSync.native(p).toLowerCase()
      } catch {
        return path.resolve(p).toLowerCase()
      }
    }
    check(
      "**écrit dans le dossier temporaire de la session** (Windows n'a pas de mode POSIX)",
      real(path.dirname(file)).startsWith(real(tmpdir())),
      `${real(path.dirname(file))} hors de ${real(tmpdir())}`
    )
  } else {
    check("**lisible par son seul propriétaire**", (statSync(file).mode & 0o077) === 0, (statSync(file).mode & 0o777).toString(8))
  }
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

// ---- le lanceur Windows, pour de vrai -----------------------------------
//
// Le même exercice, sur le système où il est le plus facile à rater. `shift`
// décale `%1`, `%2`… et ne touche pas à `%*` : un `.cmd` qui fait `shift` puis
// passe `%*` renvoie « claude » comme premier argument à claude, qui démarre,
// a l'air normal, et ignore ce qu'on lui a demandé.
//
// Ce bloc ne s'exécute que sous Windows, et il s'exécute vraiment : la
// construction de la release lance `npm run typecheck` sur un runner Windows
// avant d'empaqueter. Un garde qui ne tourne jamais là où il porte n'est pas un
// garde.
if (process.platform === "win32") {
  const fake = path.join(dir, "bin")
  mkdirSync(fake, { recursive: true })
  // Un faux agent qui écrit ce qu'on lui a passé, un argument par ligne.
  for (const name of ["claude", "codex"]) {
    writeFileSync(
      path.join(fake, `${name}.cmd`),
      ["@echo off", ":loop", 'if "%~1"=="" exit /b 0', "echo %~1", "shift", "goto loop", ""].join("\r\n")
    )
  }
  const helper = path.join(path.dirname(shell.env.ZYVRO_MCP_CONFIG), "zyvro-mcp.cmd")
  check("**le lanceur Windows existe**", existsSync(helper), helper)

  const run = (...args) =>
    execFileSync(process.env.COMSPEC || "cmd.exe", ["/c", helper, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...shell.env, PATH: `${fake}${path.delimiter}${shell.env.PATH}` },
    })

  {
    const out = run("claude", "--model", "opus").split(/\r?\n/).map((l) => l.trim())
    check(
      "**claude part avec la configuration du projet**",
      out.includes("--mcp-config") && out.includes(shell.env.ZYVRO_MCP_CONFIG),
      out.join(" ")
    )
    check("et seulement celle du projet", out.includes("--strict-mcp-config"), out.join(" "))
    check("**ce qu'on tape derrière arrive**", out.includes("--model") && out.includes("opus"), out.join(" "))
    // Le piège : avec `%*` après un `shift`, « claude » repartirait comme
    // premier argument de claude.
    check("**et le verbe ne repart pas avec**", !out.includes("claude"), out.join(" "))
  }

  {
    const out = run("codex", "exec", "bonjour").split(/\r?\n/).map((l) => l.trim())
    check(
      "**codex part avec l'adresse du moteur**",
      out.some((line) => line.includes("mcp_servers.zyvro.url=")),
      out.join(" ")
    )
    check(
      "et le jeton reste dans l'environnement",
      out.some((line) => line.includes("bearer_token_env_var=")) && !out.some((line) => line.includes("jeton-moteur")),
      out.join(" ")
    )
    check("**ce qu'on tape derrière arrive**", out.includes("exec") && out.includes("bonjour"), out.join(" "))
    check("et le verbe ne repart pas avec", !out.includes("codex"), out.join(" "))
  }

  {
    const out = run()
    check(
      "**seul, il dit tout ce qu'il y a**",
      out.includes("http://127.0.0.1:4123/mcp") && out.includes(shell.env.ZYVRO_MCP_CONFIG),
      out
    )
    check("en anglais lui aussi", !/[éèêàçù]/.test(out), out)
    check("y compris le serveur de capture", out.includes(handle.origin), out)
  }

  {
    // Un verbe inconnu doit se plaindre et sortir en erreur, pas lancer quelque
    // chose au hasard.
    let code = 0
    try {
      execFileSync(process.env.COMSPEC || "cmd.exe", ["/c", helper, "gemini"], {
        encoding: "utf8",
        env: { ...process.env, ...shell.env, PATH: `${fake}${path.delimiter}${shell.env.PATH}` },
        stdio: "pipe",
      })
    } catch (err) {
      code = err.status
    }
    check("**un client qu'il ne sait pas brancher est refusé**", code === 2, `code ${code}`)
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
