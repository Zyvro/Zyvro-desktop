import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SHOTS_SERVER, shotsEndpoint } from "./shots"

// Ce que le projet ouvert offre en MCP, à un seul endroit.
//
// Il y a deux serveurs et trois façons de les nommer : le fichier `mcp.json`
// que lisent claude et la plupart des clients, les `-c mcp_servers.…` de codex,
// et les variables d'environnement d'un agent lancé à la main dans le shell. Si
// chacune tenait sa propre liste, ajouter un serveur en brancherait deux sur
// trois, et le troisième ne dirait rien : l'agent aurait simplement moins
// d'outils, sans que rien n'échoue.
//
// Les deux serveurs :
//
//   zyvro      le démon du projet — les workflows, leur exécution, leurs
//              sorties. C'est un autre processus, il ne sait rien de la fenêtre.
//   zyvro-app  l'application elle-même — la capture d'écran d'une fenêtre. Un
//              démon ne peut pas photographier une fenêtre Electron.

// Le serveur porte ici le nom que la documentation du produit hébergé emploie :
// un agent qui a déjà utilisé Zyvro en MCP retrouve exactement ce qu'il attend.
export const MCP_SERVER = "zyvro"

// Les noms des variables sont l'interface : codex lit le jeton dedans plutôt
// que sur sa ligne de commande, et un agent lancé au shell les lit pour se
// brancher tout seul. Les renommer casse les deux.
export const MCP_URL_ENV = "ZYVRO_MCP_URL"
export const MCP_TOKEN_ENV = "ZYVRO_MCP_TOKEN"
export const SHOTS_URL_ENV = "ZYVRO_SHOTS_URL"
export const SHOTS_TOKEN_ENV = "ZYVRO_SHOTS_TOKEN"
export const MCP_CONFIG_ENV = "ZYVRO_MCP_CONFIG"

// McpTarget est le strict nécessaire pour joindre le démon. AgentContext en est
// un, mais tout ce qui ouvre un shell n'a pas de conversation ni de workflows.
export type McpTarget = { daemonOrigin?: string; daemonToken?: string }

export function mcpAvailable(ctx: McpTarget): boolean {
  return Boolean(ctx.daemonOrigin && ctx.daemonToken)
}

export function mcpUrl(ctx: McpTarget): string {
  return `${ctx.daemonOrigin}/mcp`
}

type ServerEntry = { type: "http"; url: string; headers: { Authorization: string } }

// mcpServers est la liste. Tout le reste de ce fichier en dérive.
export function mcpServers(ctx: McpTarget): Record<string, ServerEntry> {
  if (!mcpAvailable(ctx)) return {}
  const shots = shotsEndpoint()
  return {
    [MCP_SERVER]: {
      type: "http",
      url: mcpUrl(ctx),
      headers: { Authorization: `Bearer ${ctx.daemonToken}` },
    },
    ...(shots
      ? {
          [SHOTS_SERVER]: {
            type: "http",
            url: shots.origin,
            headers: { Authorization: `Bearer ${shots.token}` },
          },
        }
      : {}),
  }
}

// writeMcpConfig écrit la définition dans un fichier plutôt que sur la ligne de
// commande : elle porte le jeton du démon, et argv est lisible par tous les
// processus de la machine. Propriétaire seul, et effacé quand on a fini.
//
// Hors du projet, délibérément : `.zyvro/` est fait pour être commité, et un
// jeton n'a rien à faire dans un dépôt.
export function writeMcpConfig(ctx: McpTarget, dialecte: McpDialect = "claude"): { path: string; dispose: () => void } {
  const written = mcpDirectory(ctx, dialecte)
  return { path: written.file, dispose: written.dispose }
}

// Les deux façons d'écrire la même chose.
//
// La liste des serveurs reste une, celle de `mcpServers`. Ce qui diffère est le
// nom du champ qui porte l'adresse, et c'est un piège complet : Qwen Code lit
// `url` comme un point d'accès SSE et `httpUrl` comme du HTTP en flux. Lui
// donner la forme de claude ne produit pas d'erreur de configuration — il
// essaie de parler SSE à un serveur qui n'en fait pas, et rend un avertissement
// au milieu de sa sortie : « MCP server(s) failed to start: zyvro, zyvro-app.
// Continuing with built-in tools ».
//
// Continuing, justement. Le tour se déroule, l'agent répond, et il n'a
// simplement aucun des outils de ce projet. Trouvé en regardant pourquoi une
// session qwen ne savait rien de nos workflows.
export type McpDialect = "claude" | "qwen"

function serversFor(ctx: McpTarget, dialecte: McpDialect): Record<string, unknown> {
  const servers = mcpServers(ctx)
  if (dialecte !== "qwen") return servers
  const out: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(servers)) {
    const { type: _ignore, url, ...reste } = server
    out[name] = { ...reste, httpUrl: avecChemin(url) }
  }
  return out
}

// avecChemin : une adresse nue ne suffit pas à Qwen Code.
//
// Les deux serveurs sont écrits pareil et un seul démarrait : `zyvro` porte
// `/mcp` et se branche, `zyvro-app` est une origine sans chemin et échouait.
// Le serveur de l'application, lui, répond sur n'importe quel chemin — il lit
// le corps JSON-RPC et ignore l'adresse — donc lui en donner un ne coûte rien
// et le rend joignable.
//
// Seulement pour ce dialecte : claude s'accommode de l'origine nue, et changer
// ce qui marche pour aligner deux écritures serait la façon la plus sûre de
// casser celle qui allait bien.
function avecChemin(url: string): string {
  try {
    return new URL(url).pathname === "/" ? `${url.replace(/\/$/, "")}/mcp` : url
  } catch {
    return url
  }
}

// mcpDirectory écrit le fichier là où le système protège déjà les secrets.
//
// Le fichier porte deux jetons. `0600` dit qui peut le lire là où /tmp est
// commun à tout le monde — et ne dit rien sous Windows, qui ignore ces bits :
// la protection y vient du dossier, `%LOCALAPPDATA%\Temp`, qui appartient à la
// session. C'est la même phrase de deux façons, et il faut les deux : le mode
// seul ne protège rien sous Windows, le dossier seul ne protège rien sur une
// machine Unix partagée où /tmp est ouvert.
function mcpDirectory(ctx: McpTarget, dialecte: McpDialect = "claude"): { dir: string; file: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "zyvro-mcp-"))
  const file = path.join(dir, "mcp.json")
  writeFileSync(file, JSON.stringify({ mcpServers: serversFor(ctx, dialecte) }, null, 2), { mode: 0o600 })
  return { dir, file, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

// codexMcpArgs : codex ne lit pas de fichier de configuration, il prend des
// `-c` — et le jeton passe par l'environnement, pas par la ligne de commande.
export function codexMcpArgs(ctx: McpTarget): string[] {
  const args: string[] = []
  for (const [name, server] of Object.entries(mcpServers(ctx))) {
    args.push(
      "-c",
      `mcp_servers.${name}.url="${server.url}"`,
      "-c",
      `mcp_servers.${name}.bearer_token_env_var="${name === MCP_SERVER ? MCP_TOKEN_ENV : SHOTS_TOKEN_ENV}"`
    )
  }
  return args
}

// mcpTokenEnv : les jetons que codex va chercher dans son environnement.
export function mcpTokenEnv(ctx: McpTarget): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  const servers = mcpServers(ctx)
  if (servers[MCP_SERVER]) env[MCP_TOKEN_ENV] = ctx.daemonToken
  const shots = shotsEndpoint()
  if (servers[SHOTS_SERVER] && shots) env[SHOTS_TOKEN_ENV] = shots.token
  return env
}

// ---------------------------------------------------------------------------
// Le shell
//
// Le panneau d'agent branche `claude` et `codex` lui-même. Mais on ouvre aussi
// des shells, et ce qu'on y lance — un autre agent, un client MCP, un `curl` de
// vérification — n'a aucun moyen de deviner sur quel port le démon de ce projet
// écoute ni quel jeton l'ouvre. Ces deux choses changent à chaque démarrage.
//
// Alors chaque shell que l'application ouvre les porte : les adresses et les
// jetons dans son environnement, un `mcp.json` prêt à être donné à n'importe
// quel client, et un `zyvro-mcp` sur le PATH qui lance un agent déjà branché.
//
// Le fichier et le script vivent dans un dossier temporaire à eux, en
// propriétaire seul, effacés quand le shell se termine : la durée de vie du
// jeton est celle de la session qui peut s'en servir.

const HELPER = "zyvro-mcp"

export type ShellMcp = {
  env: Record<string, string | undefined>
  // Deux lignes écrites dans le terminal avant la première invite. Sans elles,
  // tout ceci est branché et personne ne le sait.
  banner: string
  dispose: () => void
}

export function shellMcp(ctx: McpTarget): ShellMcp | null {
  if (!mcpAvailable(ctx)) return null
  const servers = mcpServers(ctx)
  const written = mcpDirectory(ctx)

  const env: Record<string, string | undefined> = {
    ...mcpTokenEnv(ctx),
    [MCP_URL_ENV]: servers[MCP_SERVER]?.url,
    [SHOTS_URL_ENV]: servers[SHOTS_SERVER]?.url,
    [MCP_CONFIG_ENV]: written.file,
    PATH: `${written.dir}${path.delimiter}${process.env.PATH ?? ""}`,
  }

  writeHelper(written.dir, ctx)

  return {
    env,
    banner: banner(servers, written.file),
    dispose: written.dispose,
  }
}

// banner : ce que le shell dit de lui-même en s'ouvrant.
//
// En anglais, comme le reste de l'interface : les commentaires de ce dépôt sont
// en français, ce que la personne lit ne l'est pas.
//
// Gris et deux lignes : c'est un rappel, pas une annonce. Il nomme les serveurs
// branchés et la commande qui les utilise, parce qu'une variable
// d'environnement que personne ne sait chercher n'aide personne.
function banner(servers: Record<string, ServerEntry>, config: string): string {
  const names = Object.keys(servers).join(" · ")
  const dim = (line: string): string => `\x1b[2m${line}\x1b[0m\r\n`
  return (
    dim(`MCP ${names} — ${HELPER} claude · ${HELPER} codex · ${HELPER} for the details`) +
    // Le chemin en entier, pas le nom de la variable : c'est ce qu'on colle
    // dans la configuration d'un autre client, et le jeton reste dans le
    // fichier, lisible par son seul propriétaire.
    dim(`    any other client: ${config}`)
  )
}

// quote protège une valeur pour /bin/sh. Les adresses sont des URL et les
// arguments de codex portent des guillemets ; sans ça, un `-c mcp_servers…`
// arriverait coupé en deux et le serveur ne serait pas déclaré.
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// quoteCmd : le même travail, pour `cmd`, qui ne connaît pas l'apostrophe.
//
// Trouvé en le lançant sur Windows, ce qui était tout l'objet de l'exercice :
// les drapeaux de codex étaient écrits à la mode POSIX dans un `.cmd`, où
// l'apostrophe n'est qu'un caractère ordinaire. `codex` recevait `'-c'` puis
// une moitié de la deuxième, coupée sur le guillemet, et cmd finissait par
// « The syntax of the command is incorrect. »
//
// Ici, tout est entre guillemets doubles et les guillemets intérieurs sont
// doublés : c'est la convention que l'analyseur d'arguments de Windows défait
// pour rendre le guillemet littéral que TOML attend autour d'une adresse.
export function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function writeHelper(dir: string, ctx: McpTarget): void {
  const codex = codexMcpArgs(ctx).map(quote).join(" ")
  const codexCmd = codexMcpArgs(ctx).map(quoteCmd).join(" ")
  const lines = [
    "#!/bin/sh",
    "# zyvro-mcp — lance un agent déjà branché sur les serveurs MCP du projet.",
    "# Écrit par Zyvro Studio pour ce shell ; il disparaît avec lui.",
    'info() {',
    `  echo "Zyvro MCP"`,
    ...Object.entries(mcpServers(ctx)).map(
      ([name, server]) =>
        `  echo "  ${name.padEnd(9)} ${server.url}"`
    ),
    `  echo "  config    ${"$" + MCP_CONFIG_ENV}"`,
    `  echo ""`,
    `  echo "  ${HELPER} claude [...]   claude, with both servers wired in"`,
    `  echo "  ${HELPER} codex  [...]   codex, with both servers wired in"`,
    `  echo "  any other client: point it at ${"$" + MCP_CONFIG_ENV}"`,
    "}",
    'case "${1:-}" in',
    // --strict-mcp-config : seulement les serveurs de ce projet. Sans lui, ceux
    // que la personne a déclarés ailleurs se rajoutent, et l'agent n'a pas les
    // mêmes outils d'une machine à l'autre.
    `  claude) shift; exec claude --mcp-config "${"$" + MCP_CONFIG_ENV}" --strict-mcp-config "$@" ;;`,
    `  codex) shift; exec codex ${codex} "$@" ;;`,
    "  ''|-h|--help|info) info ;;",
    `  *) echo "${HELPER}: I do not know how to wire \\"$1\\"" >&2; info; exit 2 ;;`,
    "esac",
    "",
  ]
  writeFileSync(path.join(dir, HELPER), lines.join("\n"), { mode: 0o700 })

  // Windows n'exécute pas un script sh, et son `.cmd` a un piège que le shell
  // POSIX n'a pas : `shift` décale `%1`, `%2`… mais ne touche pas à `%*`.
  //
  // Écrire `shift` puis passer `%*` est donc la version qui a l'air juste et qui
  // renvoie « claude » comme premier argument à claude. L'agent démarre, a l'air
  // normal, et ignore ce qu'on lui a demandé — ce qui est exactement le genre de
  // panne qu'on ne voit pas. Les arguments sont donc ramassés un par un dans une
  // variable, avec `%1` et non `%~1` pour que les guillemets de l'appelant
  // survivent : un chemin qui contient une espace est un chemin ordinaire.
  //
  // `call` parce que `claude` sur Windows est `claude.cmd` : sans lui, un `.cmd`
  // qui en appelle un autre ne revient jamais, et le code de sortie est perdu.
  if (process.platform === "win32") {
    const servers = Object.entries(mcpServers(ctx))
    const info = [
      "echo Zyvro MCP",
      ...servers.map(([name, server]) => `echo   ${name.padEnd(9)} ${server.url}`),
      `echo   config    %${MCP_CONFIG_ENV}%`,
      "echo.",
      `echo   ${HELPER} claude [...]   claude, with both servers wired in`,
      `echo   ${HELPER} codex  [...]   codex, with both servers wired in`,
      `echo   any other client: point it at %${MCP_CONFIG_ENV}%`,
    ]
    const collect = (label: string, run: string) => [
      `:${label}`,
      "shift",
      `:${label}_args`,
      `if "%~1"=="" goto ${label}_run`,
      // Chaque tour relit %ARGS% à sa propre ligne : pas besoin d'expansion
      // retardée, qui mangerait les points d'exclamation d'un chemin.
      'set "ARGS=%ARGS% %1"',
      "shift",
      `goto ${label}_args`,
      `:${label}_run`,
      run,
      "exit /b %ERRORLEVEL%",
      "",
    ]
    const cmd = [
      "@echo off",
      "rem zyvro-mcp — lance un agent deja branche sur les serveurs MCP du projet.",
      "rem Ecrit par Zyvro Studio pour ce shell ; il disparait avec lui.",
      "setlocal",
      'set "ARGS="',
      'if "%~1"=="" goto info',
      'if /i "%~1"=="-h" goto info',
      'if /i "%~1"=="--help" goto info',
      'if /i "%~1"=="info" goto info',
      'if /i "%~1"=="claude" goto claude',
      'if /i "%~1"=="codex" goto codex',
      `echo ${HELPER}: I do not know how to wire "%~1" 1>&2`,
      "call :info",
      "exit /b 2",
      "",
      ...collect(
        "claude",
        `call claude --mcp-config "%${MCP_CONFIG_ENV}%" --strict-mcp-config%ARGS%`
      ),
      ...collect("codex", `call codex ${codexCmd}%ARGS%`),
      ":info",
      ...info,
      "exit /b 0",
      "",
    ]
    writeFileSync(path.join(dir, `${HELPER}.cmd`), cmd.join("\r\n"))
  }
}
