// Installer MiMo Code sans demander à personne de taper une commande.
//
// MiMo Code n'est pas sur npm : Xiaomi le distribue en binaires, un par
// plateforme, et son installateur officiel est un script bash —
// `curl -fsSL https://mimo.xiaomi.com/install | bash`. Sur un Mac c'est une
// ligne à recopier ; sous Windows ce n'est rien du tout, il n'y a ni bash ni
// curl à qui la donner. Le bouton « Install » renvoyait donc un Windowsien à une
// commande qu'il ne peut pas lancer.
//
// Alors l'application fait ce que fait le script, elle-même, sur toutes les
// plateformes : demander la dernière version, choisir l'archive de cette
// machine, la télécharger, la décompresser avec ce que le système fournit
// déjà, et poser le binaire là où le script le pose — `~/.mimocode/bin`, pour
// qu'une installation faite ici et une faite à la main soient la même.
//
// Relevé sur le script et sur le serveur plutôt que supposé :
//
//   <base>/releases/latest                      → « 0.1.15 »
//   <base>/releases/v<version>/mimocode-<cible>.zip    (.tar.gz pour linux)
//
//   cibles : darwin-arm64, darwin-x64, windows-x64, linux-x64, linux-arm64,
//            avec « -baseline » pour un x64 sans AVX2, « -musl » pour Alpine.
//
// Chaque archive tient un seul fichier, `mimo` (`mimo.exe` sous Windows).
// Xiaomi ne publie pas de sommes de contrôle ; le script se fie à HTTPS, et
// ceci aussi. Ce qui est vérifié en plus : que le binaire posé répond, et avec
// la version annoncée.
//
// Le travail tourne dans un onglet du terminal, comme `npm install -g` pour
// les autres harnais : on voit la progression, et une panne se lit. Il est
// lancé par l'exécutable de l'application lui-même en mode Node
// (`ELECTRON_RUN_AS_NODE`), ce qui ne demande ni Node ni rien d'autre sur la
// machine.

export const MIMO_RELEASES = "https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode"

export type MimoTarget = { target: string; archive: "zip" | "tar.gz"; binary: string }

/**
 * mimoTarget : l'archive qui convient à cette machine, comme le script la
 * choisit. Null pour une plateforme que Xiaomi ne publie pas.
 */
export function mimoTarget(
  platform: string,
  arch: string,
  cpu: { avx2: boolean; musl: boolean } = { avx2: true, musl: false }
): MimoTarget | null {
  const os = platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : null
  const cpuArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null
  if (!os || !cpuArch) return null
  if (os === "windows" && cpuArch !== "x64") return null
  let target = `${os}-${cpuArch}`
  if (cpuArch === "x64" && !cpu.avx2) target += "-baseline"
  if (os === "linux" && cpu.musl) target += "-musl"
  return { target, archive: os === "linux" ? "tar.gz" : "zip", binary: os === "windows" ? "mimo.exe" : "mimo" }
}

/**
 * runMimoInstall : le téléchargeur lui-même.
 *
 * Écrit pour être sérialisé — `installerSource()` en fait le texte d'un script
 * que l'exécutable de l'application lance en mode Node. Il ne doit donc rien
 * référencer hors de son propre corps : ni import, ni fonction voisine. Ce qui
 * est dupliqué de `mimoTarget` l'est pour cette raison, et `check-mimo` vérifie
 * que les deux choisissent la même archive.
 */
export function runMimoInstall(base: string): void {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const https = require("node:https") as typeof import("node:https")
  const fs = require("node:fs") as typeof import("node:fs")
  const os = require("node:os") as typeof import("node:os")
  const path = require("node:path") as typeof import("node:path")
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  /* eslint-enable @typescript-eslint/no-require-imports */

  const say = (text: string) => process.stdout.write(`${text}\r\n`)
  const fail = (text: string): never => {
    say("")
    say(`\x1b[31mMiMo Code could not be installed: ${text}\x1b[0m`)
    say("You can also install it from https://mimo.xiaomi.com/mimocode")
    process.exit(1)
  }

  // Un GET qui suit les redirections et rend le corps, ou l'écrit dans un
  // fichier en disant où il en est.
  const get = (url: string, file: string | null, hops = 0): Promise<string> =>
    new Promise((resolve, reject) => {
      if (hops > 5) return reject(new Error("too many redirects"))
      const req = https.get(url, { headers: { "User-Agent": "Zyvro-Studio" } }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          resolve(get(new URL(res.headers.location, url).toString(), file, hops + 1))
          return
        }
        if (status !== 200) {
          res.resume()
          reject(new Error(`${url} answered ${status}`))
          return
        }
        if (!file) {
          let text = ""
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => (text += chunk))
          res.on("end", () => resolve(text))
          return
        }
        const total = Number(res.headers["content-length"] ?? 0)
        let received = 0
        let shown = -1
        const out = fs.createWriteStream(file)
        res.on("data", (chunk: Buffer) => {
          received += chunk.length
          const percent = total ? Math.floor((received / total) * 100) : -1
          if (percent !== shown && (percent % 5 === 0 || percent === 100)) {
            shown = percent
            const mb = (received / 1048576).toFixed(1)
            process.stdout.write(
              total ? `\r  ${percent}%  ${mb} / ${(total / 1048576).toFixed(1)} MB   ` : `\r  ${mb} MB   `
            )
          }
        })
        res.pipe(out)
        out.on("finish", () => {
          process.stdout.write("\r\n")
          out.close(() => resolve(file))
        })
        out.on("error", reject)
        res.on("error", reject)
      })
      req.on("error", reject)
      req.setTimeout(60_000, () => req.destroy(new Error("the download stalled")))
    })

  const run = (file: string, args: string[]) => spawnSync(file, args, { encoding: "utf8", windowsHide: true })

  // AVX2, comme le script le demande à chaque système : sans lui, la version
  // ordinaire plante au premier lancement et il faut la « baseline ».
  const avx2 = (): boolean => {
    if (process.arch !== "x64") return true
    if (process.platform === "darwin") return run("/usr/sbin/sysctl", ["-n", "hw.optional.avx2_0"]).stdout?.trim() === "1"
    if (process.platform === "linux") {
      try {
        return /\bavx2\b/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
      } catch {
        return false
      }
    }
    if (process.platform === "win32") {
      const ps =
        '(Add-Type -MemberDefinition \'[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);\' -Name K32 -Namespace W32 -PassThru)::IsProcessorFeaturePresent(40)'
      const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]).stdout ?? ""
      return out.trim().toLowerCase() === "true"
    }
    return true
  }
  const musl = (): boolean => {
    if (process.platform !== "linux") return false
    if (fs.existsSync("/etc/alpine-release")) return true
    return /musl/i.test(`${run("ldd", ["--version"]).stdout ?? ""}${run("ldd", ["--version"]).stderr ?? ""}`)
  }

  // Le même choix que `mimoTarget`, recopié ici : voir le commentaire du haut.
  const target = (() => {
    const p = process.platform
    const a = process.arch
    const sys = p === "darwin" ? "darwin" : p === "win32" ? "windows" : p === "linux" ? "linux" : null
    const cpu = a === "arm64" ? "arm64" : a === "x64" ? "x64" : null
    if (!sys || !cpu || (sys === "windows" && cpu !== "x64")) return null
    let t = `${sys}-${cpu}`
    if (cpu === "x64" && !avx2()) t += "-baseline"
    if (sys === "linux" && musl()) t += "-musl"
    return { target: t, archive: sys === "linux" ? "tar.gz" : "zip", binary: sys === "windows" ? "mimo.exe" : "mimo" }
  })()

  void (async () => {
    if (!target) fail(`Xiaomi does not publish MiMo Code for ${process.platform}/${process.arch}.`)
    const chosen = target as NonNullable<typeof target>

    say("\x1b[1mInstalling MiMo Code\x1b[0m, from Xiaomi's releases")
    let version = ""
    try {
      version = (await get(`${base}/releases/latest`, null)).trim().replace(/^v/, "")
    } catch (err) {
      fail(`could not ask which version is current (${(err as Error).message}).`)
    }
    if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) fail(`the release server answered "${version.slice(0, 40)}" for the version.`)

    const name = `mimocode-${chosen.target}.${chosen.archive}`
    say(`  version ${version}, ${name}`)
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "zyvro-mimo-"))
    const archive = path.join(work, name)
    try {
      await get(`${base}/releases/v${version}/${name}`, archive)
    } catch (err) {
      fail(`the download failed (${(err as Error).message}).`)
    }

    // Décompresser avec ce que le système a déjà : `ditto` sur un Mac, le
    // `tar.exe` de Windows 10 et suivants (il lit les zip), PowerShell sinon,
    // `tar` sous Linux.
    const unpacked = path.join(work, "out")
    fs.mkdirSync(unpacked)
    let done = false
    if (process.platform === "darwin") done = run("/usr/bin/ditto", ["-x", "-k", archive, unpacked]).status === 0
    else if (process.platform === "win32") {
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      done = fs.existsSync(tar) && run(tar, ["-xf", archive, "-C", unpacked]).status === 0
      if (!done) {
        done =
          run("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${unpacked.replace(/'/g, "''")}' -Force`,
          ]).status === 0
      }
    } else done = run("tar", ["-xzf", archive, "-C", unpacked]).status === 0
    const extracted = path.join(unpacked, chosen.binary)
    if (!done || !fs.existsSync(extracted)) fail("the archive could not be unpacked.")

    const dir = path.join(os.homedir(), ".mimocode", "bin")
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, chosen.binary)
    try {
      // Un binaire déjà là et en cours d'exécution ne se remplace pas sous
      // Windows : on le met de côté d'abord, ce que le système permet.
      if (fs.existsSync(dest)) {
        const old = `${dest}.old`
        fs.rmSync(old, { force: true })
        fs.renameSync(dest, old)
      }
      fs.copyFileSync(extracted, dest)
      fs.chmodSync(dest, 0o755)
    } catch (err) {
      fail(`could not write ${dest} (${(err as Error).message}).`)
    }
    fs.rmSync(work, { recursive: true, force: true })

    const answer = run(dest, ["--version"])
    const said = `${answer.stdout ?? ""}`.trim()
    if (answer.status !== 0 || !said.includes(version)) {
      fail(`the installed binary did not start (${(answer.stderr ?? said).trim().slice(0, 200) || `exit ${answer.status}`}).`)
    }

    say("")
    say(`\x1b[32mMiMo Code ${said} is installed\x1b[0m in ${dir}`)
    say("Sign in once: run `mimo providers login`, or start `mimo` and follow its prompt.")
    say("Zyvro picks it up by itself — go back to the agent panel.")
  })()
}

/** Le texte du script que l'exécutable de l'application lance pour installer. */
export function installerSource(base: string = MIMO_RELEASES): string {
  return `"use strict";\n(${runMimoInstall.toString()})(${JSON.stringify(base)});\n`
}
