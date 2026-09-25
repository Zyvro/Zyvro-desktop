// La Timeline : les commits d'un fichier, renommages suivis, et ce que chacun
// y a changé.
//
// Ce qui casse en silence ici :
//
// 1. **Un renommage qui coupe l'histoire.** `--follow` la suit, et chaque
//    commit garde le nom que le fichier avait alors : c'est sous ce nom-là
//    qu'on relit ses deux côtés.
// 2. **Un sujet de commit qui casse la lecture** (un retour à la ligne, un
//    séparateur) : NUL et \x01, que personne ne tape.
//
//     node scripts/check-timeline.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-timeline-check")
mkdirSync(dir, { recursive: true })
await build({ entryPoints: [path.join(ROOT, "src/shared/gitlog.ts")], outfile: path.join(dir, "h.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const maintenant = Date.parse("2026-09-25T12:00:00Z")
check("il y a 3 heures", t.relativeDate("2026-09-25T09:00:00Z", maintenant) === "3 hours ago")
check("hier", t.relativeDate("2026-09-24T11:00:00Z", maintenant) === "1 day ago")
check("à l'instant", t.relativeDate("2026-09-25T11:59:40Z", maintenant) === "just now")

// Un vrai dépôt : trois commits, un renommage au milieu.
const depot = mkdtempSync(path.join(tmpdir(), "zyvro-timeline-"))
try {
  const git = (...args) => execFileSync("git", args, { cwd: depot, encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "Essai")
  writeFileSync(path.join(depot, "vieux.ts"), "a\n")
  git("add", ".")
  git("commit", "-q", "-m", "Naissance")
  git("mv", "vieux.ts", "neuf.ts")
  git("commit", "-q", "-m", "Renommé")
  writeFileSync(path.join(depot, "neuf.ts"), "a\nb\n")
  git("commit", "-q", "-am", "Une ligne ; avec | des signes")
  const out = git("log", "--follow", "--max-count=50", t.FILE_LOG_FORMAT, "--name-only", "--", "./neuf.ts")
  const c = t.parseFileLog(out, "neuf.ts")
  check("**trois commits, renommage suivi**", c.length === 3, JSON.stringify(c))
  check("du plus récent au plus ancien", c[0]?.subject === "Une ligne ; avec | des signes" && c[2]?.subject === "Naissance")
  check("**chaque commit garde le nom d'alors**", c[0]?.path === "neuf.ts" && c[2]?.path === "vieux.ts", JSON.stringify(c.map((x) => x.path)))
  check("auteur et hash", c[0]?.author === "Essai" && /^[0-9a-f]{40}$/.test(c[0]?.hash ?? "") && c[0]?.short.length >= 7)
} finally {
  rmSync(depot, { recursive: true, force: true })
}

{
  const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")
  check("le principal suit les renommages, hors du journal Git Output", /"log", "--follow"/.test(lire("src/main/git.ts")) && /quiet: true \}\s*\)\s*\n\s*return parseFileLog/.test(lire("src/main/git.ts")))
  check("un commit se lit contre son parent", /fileAt\(path, `\$\{commit\}\^`\)/.test(lire("src/renderer/panels/DiffView.tsx")))
  check("la section est dans l'Explorateur", /<TimelineList \/>/.test(lire("src/renderer/App.tsx")))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nL'histoire d'un fichier, renommages compris, à un clic de chaque changement.")
