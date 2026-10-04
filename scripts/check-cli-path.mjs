// Le PATH qu'une application graphique reçoit n'est pas celui que vous avez.
//
// Sur macOS, lancer une app depuis le Finder passe par launchd, qui ne lit
// aucun profil de shell. Le processus démarre avec le PATH par défaut du
// système, donc tout ce qu'un gestionnaire de paquets a installé est invisible.
// `claude` et `codex` vivent couramment dans ~/.local/bin, qui n'y figure pas.
//
// Ce défaut a survécu à tous mes essais pour une seule raison : je lançais
// l'application depuis un terminal, où elle héritait de mon PATH. C'est le
// genre de chose qu'on ne voit jamais en développant et que le premier
// utilisateur voit tout de suite.
//
// Ce script reproduit donc les conditions du Finder — un environnement vidé
// avec le PATH minimal de launchd — et vérifie que le module retrouve quand
// même ce que la machine sait.
//
//     node scripts/check-cli-path.mjs
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-cli-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export * from "${path.join(ROOT, "src/main/cli").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const harness = path.join(dir, "h.cjs")
const { merge, locate, shimTarget, direct, scrubParentAgentEnv } = createRequire(import.meta.url)(harness)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const windows = process.platform === "win32"
const sep = windows ? ";" : ":"

// ---- merge, la partie pure --------------------------------------------
check("ce qui arrive passe devant", merge(`${sep}bin`, `a${sep}bin`).startsWith("a"))
check("rien n'est perdu de ce qu'on avait", merge("/only/here", "/from/shell").split(sep).includes("/only/here"))
check("pas de doublon", merge(`/bin${sep}/usr/bin`, `/usr/bin${sep}/bin`).split(sep).length === 2)
check("les entrées vides sont ignorées", !merge(`${sep}${sep}/bin`, `/x${sep}${sep}`).split(sep).includes(""))
check("un PATH vide au départ ne casse rien", merge("", `/a${sep}/b`) === `/a${sep}/b`)
if (windows) {
  // Les chemins Windows ne sont pas sensibles à la casse, donc C:\Bin et c:\bin
  // sont la même entrée et en garder deux allongerait le PATH pour rien.
  check("la casse ne fabrique pas de doublon", merge("C:\\Bin", "c:\\bin").split(sep).length === 1)
}

// ---- le cas réel : un environnement de type Finder ---------------------
if (windows) {
  // Sur Windows il n'y a pas de shell de connexion à interroger : un processus
  // graphique hérite du PATH de la base de registres. Ce qui s'y joue est
  // l'extension, vérifiée juste en dessous.
  console.log("  (pas de shell de connexion à réparer sur Windows)")
} else {
  const LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin"
  const clean = { PATH: LAUNCHD, HOME: process.env.HOME, SHELL: process.env.SHELL, USER: process.env.USER }
  const probe = `
    const { prepare } = require(${JSON.stringify(harness)})
    prepare(["claude", "codex"]).then(() => process.stdout.write(process.env.PATH || ""))
  `
  const after = execFileSync(process.execPath, ["-e", probe], { env: clean, encoding: "utf8", timeout: 40000 }).trim()

  check("le PATH de départ était bien celui d'une app graphique", LAUNCHD.split(":").every((p) => after.includes(p)))
  check("il s'est enrichi", after.split(":").length > LAUNCHD.split(":").length, `obtenu : ${after}`)

  // La référence est un shell de connexion lancé dans le MÊME environnement
  // vidé. Le comparer à un shell lancé d'ici donnerait un PATH déjà pollué par
  // le terminal courant — c'est la fuite qui avait masqué le défaut, et elle
  // ferait échouer ce test pour la mauvaise raison.
  const login = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf %s "$PATH"'], {
    env: clean, encoding: "utf8", timeout: 30000,
  }).trim()
  const missing = login.split(":").map((p) => p.trim()).filter(Boolean).filter((p) => !after.split(":").includes(p))
  check("tout ce que le shell de connexion connaît est repris", missing.length === 0, `manquant : ${missing.join(", ")}`)

  // ---- le reste de l'environnement, qui est le même défaut ------------
  //
  // PATH a été réparé le premier parce qu'il a manqué le premier. Mais launchd
  // ne cache pas le PATH, il cache le profil : NVM_DIR, HOMEBREW_PREFIX,
  // GOPATH, LANG et les clefs que les gens gardent dans leur configuration de
  // shell manquent exactement de la même façon. Un terminal ouvert dans l'app
  // n'était alors toujours pas le leur, et un agent lancé depuis l'app ne
  // pouvait toujours pas atteindre ce que leur shell atteint.
  const dump = `
    const { prepare } = require(${JSON.stringify(harness)})
    prepare(["claude", "codex"]).then(() => process.stdout.write(JSON.stringify(process.env)))
  `
  const apres = JSON.parse(
    execFileSync(process.execPath, ["-e", dump], { env: clean, encoding: "utf8", timeout: 40000 })
  )

  // La référence : ce que le shell de connexion exporte, lu dans le même
  // environnement vidé.
  const exported = {}
  const raw = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "/usr/bin/env -0"], {
    env: clean, encoding: "utf8", timeout: 30000,
  })
  for (const entry of raw.split("\0")) {
    const at = entry.indexOf("=")
    if (at > 0) exported[entry.slice(0, at)] = entry.slice(at + 1)
  }

  // Ce que le shell dit de lui-même plutôt que de la personne, et que l'app a
  // déjà de sa part à elle.
  const sien = new Set(["_", "PWD", "OLDPWD", "SHLVL", "TMPDIR", "PATH", "ZYVRO_SHELL_PROBE"])
  const perdues = Object.keys(exported).filter((k) => !sien.has(k) && apres[k] === undefined)
  check("ce que le profil exporte arrive jusqu'à l'application", perdues.length === 0, `manquant : ${perdues.join(", ")}`)

  // Et l'inverse : ce que launchd a donné reste ce que launchd a donné. Un
  // profil est la revendication la plus faible des deux, et c'est ce qui
  // garantit qu'une app lancée depuis un terminal garde l'environnement de ce
  // terminal — le seul cas qui marchait déjà.
  check("ce que le processus tenait déjà n'est pas écrasé", apres.HOME === clean.HOME && apres.USER === clean.USER)

  // Et la conséquence, qui est le vrai sujet.
  for (const bin of ["claude", "codex"]) {
    const reachable = (env) => {
      try {
        return execFileSync("/usr/bin/which", [bin], { env: { PATH: env }, encoding: "utf8" }).trim()
      } catch {
        return ""
      }
    }
    const expected = reachable(login)
    if (!expected) {
      console.log(`  (${bin} n'est pas installé ici, rien à vérifier)`)
      continue
    }
    check(`\`${bin}\` est retrouvé depuis un lancement graphique`, reachable(after) === expected, `attendu ${expected}, obtenu ${reachable(after) || "rien"}`)
    check(`et il était bien introuvable sans le correctif`, reachable(LAUNCHD) === "")
  }
}

// ---- locate, et l'extension que Windows exige --------------------------
//
// Un .cmd est un script pour l'interpréteur de commandes, pas un exécutable :
// Node refuse de le lancer sans shell, et l'échec se lit « fichier
// introuvable » pour un fichier qui est là. C'est ce que `needsShell` porte.
const sandbox = path.join(dir, "faux-bin")
mkdirSync(sandbox, { recursive: true })
const name = windows ? "outil.cmd" : "outil"
writeFileSync(path.join(sandbox, name), windows ? "@echo off\n" : "#!/bin/sh\n", { mode: 0o755 })

const saved = process.env.PATH
process.env.PATH = merge(saved ?? "", sandbox)
const found = locate("outil")
check("locate trouve un outil posé sur le PATH", Boolean(found), `PATH: ${sandbox}`)
check("et rend le fichier avec son extension", found?.file.endsWith(name), found?.file)
check(
  windows ? "un .cmd est signalé comme ayant besoin d'un shell" : "rien n'a besoin d'un shell ici",
  found?.needsShell === windows
)
check("un outil absent n'est pas inventé", locate("outil-qui-n-existe-pas") === null)
process.env.PATH = saved

// ---- la sonde ne prend pas le terminal ---------------------------------
//
// Les shells interrogés au démarrage sont interactifs (`-i`), et un shell
// interactif prend le terminal auquel il est rattaché. Lancés depuis `npm run
// dev`, ils prenaient celui de la personne, étaient tués, et son zsh mourait sur
// « error on TTY read: Input/output error ». Détachés, ils n'ont pas de terminal
// à prendre.
{
  const source = readFileSync(path.join(ROOT, "src/main/cli.ts"), "utf8")
  const sonde = source.slice(source.indexOf('spawn(shell, ["-ilc"'), source.indexOf('spawn(shell, ["-ilc"') + 400)
  check("**la sonde des shells tourne détachée du terminal**", /detached: true/.test(sonde), sonde.slice(0, 200))
  const index = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check(
    "**le développement a son propre profil, et donc son propre verrou**",
    /app\.setPath\("userData", path\.join\(app\.getPath\("appData"\), "zyvro-desktop-dev"\)\)/.test(index),
    "partager celui de l'app installée faisait quitter `npm run dev` dès qu'elle était ouverte"
  )
}

// ---- les scripts .cmd de npm, sous Windows ----
//
// Lancer `claude.cmd` par cmd.exe cassait le panneau d'agent : sans guillemets,
// le préambule sur plusieurs lignes était coupé au premier retour à la ligne,
// et un tour ne donnait rien. On lit le script pour lancer node directement.
{
  // Le texte tel que cmd-shim l'écrit aujourd'hui, et tel qu'il l'écrivait.
  const moderne = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n")
  const ancien = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)'
  const npmDir = path.join(dir, "npm")
  const m = shimTarget(moderne, npmDir)
  check(
    "**un script cmd-shim d'aujourd'hui mène à son cli.js**",
    m?.viaNode === true && m.script === path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    JSON.stringify(m)
  )
  const a = shimTarget(ancien, npmDir)
  check("et l'ancienne forme aussi", a?.viaNode === true && a.script.endsWith(path.join("@openai", "codex", "bin", "codex.js")), JSON.stringify(a))
  check("un script qui ne lance rien de connu n'est pas deviné", shimTarget("@echo off\r\necho bonjour", npmDir) === null)
  const exe = shimTarget('"%dp0%\\node_modules\\x\\bin\\tool.exe" %*', npmDir)
  check("un script qui lance un .exe le lance tel quel", exe?.viaNode === false && exe.script.endsWith(path.join("bin", "tool.exe")))

  // Une maquette d'installation npm : le script, son cli.js, et le node.exe d'à côté.
  mkdirSync(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code"), { recursive: true })
  writeFileSync(path.join(npmDir, "claude.cmd"), moderne)
  writeFileSync(path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "")
  writeFileSync(path.join(npmDir, "node.exe"), "")
  const d = direct({ file: path.join(npmDir, "claude.cmd"), needsShell: true })
  check(
    "**claude.cmd se lance par node, sans cmd.exe — les arguments sur plusieurs lignes passent**",
    d.shell === false && d.file === path.join(npmDir, "node.exe") && d.prefix[0] === path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    JSON.stringify(d)
  )
  check("un exécutable ordinaire reste tel quel", direct({ file: "/bin/ls", needsShell: false }).shell === false)
  const source = readFileSync(path.join(ROOT, "src/main/cli.ts"), "utf8")
  check("**launch passe par là, et sans fenêtre de console**", /const how = direct\(found\)/.test(source) && /windowsHide: true/.test(source))
}

// Lancée depuis une session de Claude Code, l'app en héritait les marqueurs, et
// tout ce qu'elle lançait aussi : le claude ouvert dans son terminal disait
// « saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker » et ne pouvait
// plus reprendre de session.
{
  const env = {
    PATH: "/usr/bin",
    HOME: "/h",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/s.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "t",
    CLAUDE_PID: "42",
    CLAUDE_CONFIG_DIR: "/garde",
    ANTHROPIC_API_KEY: "garde",
  }
  const retires = scrubParentAgentEnv(env)
  check(
    "**les marqueurs de la session d'agent parente sont retirés**",
    !("CLAUDECODE" in env) && !("CLAUDE_CODE_CHILD_SESSION" in env) && !("CLAUDE_CODE_SESSION_ID" in env) && !("CLAUDE_CODE_MESSAGING_SOCKET" in env) && !("CLAUDE_PID" in env),
    JSON.stringify(Object.keys(env))
  )
  check(
    "**et rien d'autre : la configuration de l'utilisateur reste**",
    env.CLAUDE_CONFIG_DIR === "/garde" && env.ANTHROPIC_API_KEY === "garde" && env.PATH === "/usr/bin" && retires.length === 6,
    JSON.stringify(retires)
  )
  const index = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check(
    "et c'est fait au démarrage, avant que l'app lance quoi que ce soit",
    index.indexOf("scrubParentAgentEnv(process.env)") > 0 && index.indexOf("scrubParentAgentEnv(process.env)") < index.indexOf("app.whenReady()")
  )
}

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nLes CLI de la machine sont trouvables depuis l'application." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
