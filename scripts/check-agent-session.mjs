// La mémoire de l'agent tient à deux détails invisibles quand ils sont faux.
//
// Le panneau lance le CLI de la machine, un processus neuf par tour. Ce qui
// transforme une suite de questions en conversation, c'est l'identifiant de
// session : `claude --resume <id>` et `codex exec resume <id>` reprennent le fil
// là où il s'est arrêté.
//
// Les deux CLI ne s'accordent sur rien de tout cela, et aucun ne proteste quand
// on se trompe :
//
//   claude   --resume <id> est un drapeau, n'importe où sur la ligne
//   codex    resume est une SOUS-COMMANDE, avant ses options, id positionnel
//
// Mettre l'identifiant de codex au mauvais endroit le fait lire comme le
// prompt : le processus démarre, le modèle répond à une question faite d'un
// UUID, et rien nulle part ne dit que la session n'a pas été reprise. De même,
// l'identifiant s'appelle `session_id` chez l'un et `thread_id` chez l'autre —
// se tromper ne coûte aucune erreur, seulement un agent de nouveau amnésique.
//
// Les deux formes ont été relevées sur les binaires installés, pas de mémoire.
//
//     node scripts/check-agent-session.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-agent-check")
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, "h.ts"), `export { argsFor, sessionIn } from "${path.join(ROOT, "src/main/agent").replace(/\\/g, "/")}"\n`)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { argsFor, sessionIn } = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const ctx = { projectDir: "/tmp/projet", workflows: [] }
const ID = "cf0e09bb-dd85-4350-95d4-2f5ba499ec44"

// ---- claude ------------------------------------------------------------
const claudeFresh = argsFor("claude", ctx, null)
check("un premier tour claude ne reprend rien", !claudeFresh.includes("--resume"), claudeFresh.join(" "))
check("il demande bien le flux JSON", claudeFresh.join(" ").includes("--output-format stream-json"))

const claudeResumed = argsFor("claude", ctx, ID)
const at = claudeResumed.indexOf("--resume")
check("un tour suivant reprend la session", at !== -1)
check("et l'identifiant suit immédiatement le drapeau", claudeResumed[at + 1] === ID, claudeResumed.join(" "))
check("le reste de la ligne est intact", claudeResumed.slice(0, claudeFresh.length).join(" ") === claudeFresh.join(" "))

// ---- codex -------------------------------------------------------------
const codexFresh = argsFor("codex", ctx, null)
check("un premier tour codex n'a pas de sous-commande resume", !codexFresh.includes("resume"), codexFresh.join(" "))
check("il commence par exec", codexFresh[0] === "exec")

const codexResumed = argsFor("codex", ctx, ID)
check("un tour suivant passe par resume", codexResumed[0] === "exec" && codexResumed[1] === "resume", codexResumed.join(" "))
check(
  "resume vient avant ses options — l'inverse ne serait pas analysé",
  codexResumed.indexOf("resume") < codexResumed.indexOf("--json"),
  codexResumed.join(" ")
)
check(
  "l'identifiant est positionnel et vient après les options",
  codexResumed[codexResumed.length - 1] === ID,
  codexResumed.join(" ")
)
// Le piège : un identifiant mis avant --json serait lu comme le prompt.
check("aucune option ne suit l'identifiant", codexResumed.slice(codexResumed.indexOf(ID)).length === 1)

// ---- de quel champ vient l'identifiant ---------------------------------
check("claude l'appelle session_id", sessionIn({ type: "system", session_id: ID }) === ID)
check("codex l'appelle thread_id", sessionIn({ type: "thread.started", thread_id: ID }) === ID)
check("un événement sans identifiant n'en invente pas", sessionIn({ type: "assistant" }) === null)
check("une chaîne vide n'est pas un identifiant", sessionIn({ session_id: "" }) === null)
check("un identifiant qui n'est pas une chaîne est refusé", sessionIn({ session_id: 42 }) === null)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nLa reprise de session est passée aux deux CLI comme ils l'attendent." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
