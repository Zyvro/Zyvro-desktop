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
writeFileSync(
  path.join(dir, "h.ts"),
  `export { argsFor, sessionIn, modelIn, aliasesFrom, promptWith } from "${path.join(ROOT, "src/main/agent").replace(/\\/g, "/")}"\n` +
    // Le serveur de l'application sert l'outil par lequel la CLI demande une
    // permission : sans lui qui écoute, il n'y a personne à qui poser la
    // question, et les drapeaux le disent.
    `export { startShotsServer } from "${path.join(ROOT, "src/main/shots").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true, format: "cjs", platform: "node", external: ["electron"],
  absWorkingDir: ROOT, logLevel: "silent",
})
const { argsFor, sessionIn, modelIn, aliasesFrom, promptWith, startShotsServer } = createRequire(import.meta.url)(
  path.join(dir, "h.cjs")
)

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); failures++ }
}

const ctx = { projectDir: "/tmp/projet", workflows: [] }
// Le serveur de l'application écoute : c'est lui qui porterait la question.
const appServer = await startShotsServer(() => [], undefined, async () => ({ allow: true }))
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

// ---- ce que l'agent a le droit de faire ---------------------------------
//
// Un tour en mode impression ne peut poser aucune question tout seul. Sans ces
// drapeaux, la CLI demande la permission d'écrire, personne ne peut répondre,
// et l'agent rend « you haven't granted it yet » pour un fichier du dossier
// qu'on vient de lui ouvrir. Vu sur une vraie session, signalé par Jeremy.
//
// Aucun de ces drapeaux n'échoue bruyamment quand il manque : leur absence rend
// l'agent impuissant, ou, dans l'autre sens, sans limite.
{
  const claudeArgs = (permission) => argsFor("claude", { ...ctx, permission }, null).join(" ")
  const codexArgs = (permission) => argsFor("codex", { ...ctx, permission }, null).join(" ")

  // Le défaut : tout le projet, sans rien demander — et RIEN QUE le projet.
  //
  // C'était `bypassPermissions`, et le nom du mode a été pris pour une
  // frontière. Signalé par Jeremy le 18/09 (« l'agent en mode workspace a pu
  // écrire un fichier hors du workspace ») et refait à la main : en
  // `bypassPermissions`, « écris dans ../DEHORS.txt » crée le fichier un niveau
  // au-dessus du projet, sans un mot.
  //
  // Les quatre modes ont été essayés sur le binaire plutôt que choisis au nom :
  // `bypassPermissions` et `auto` sortent du projet ; `dontAsk` refuse dehors
  // mais refuse aussi dedans — plus d'écriture, plus de commande ;
  // `acceptEdits` écrit et lance des commandes dans le projet et refuse d'en
  // sortir, **y compris par le shell** : `echo sorti > ../DEHORS.txt` revient
  // « refusé par le système de permissions, pas par moi ».
  check(
    "**par défaut, claude ne demande rien — et ne sort pas du projet**",
    claudeArgs(undefined).includes("--permission-mode acceptEdits"),
    claudeArgs(undefined)
  )
  check(
    "**et il ne repasse pas par le mode qui laissait sortir**",
    !claudeArgs(undefined).includes("bypassPermissions") && !claudeArgs(undefined).includes("--permission-mode auto "),
    "bypassPermissions écrit hors du projet : mesuré, pas supposé"
  )
  // En mode impression personne ne peut répondre : ce qui demanderait doit être
  // refusé, pas attendu.
  check(
    "et ce qui demanderait est refusé, pas laissé pendre",
    claudeArgs(undefined).includes("--permission-prompts none"),
    claudeArgs(undefined)
  )
  check("**et codex écrit dans le dossier du projet**", codexArgs(undefined).includes("--sandbox workspace-write"), codexArgs(undefined))
  check("sans bac à sable désactivé pour autant", !codexArgs(undefined).includes("--dangerously-bypass"))

  // « Ask » : la question remonte dans le panneau par l'outil MCP de
  // l'application. Sans `--permission-prompts host`, elle mourrait dans un tour
  // qui ne peut répondre à personne.
  const asking = claudeArgs("ask")
  // `manual` est le mode qui demande : c'est lui qui décide, pas le routage.
  // Vérifié contre le binaire — sans lui, une écriture passe sans rien
  // demander, et « Ask » ne demandait rien du tout.
  check("**en mode Ask, la CLI demande vraiment**", asking.includes("--permission-mode manual"), asking)
  check("**et la question part vers le panneau**", asking.includes("--permission-prompts host"), asking)
  check(
    "et elle nomme l'outil qui la porte",
    asking.includes("--permission-prompt-tool mcp__zyvro-app__zyvro_permission"),
    asking
  )

  // « Read only » : rien ne s'écrit, et ce qui demanderait est refusé tout de
  // suite plutôt que laissé en attente.
  const reading = claudeArgs("read")
  check("**en lecture seule, les outils d'écriture sont interdits**", reading.includes("--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Bash"), reading)
  check("et personne n'est censé répondre", reading.includes("--permission-prompts none"))
  check("dans le mode qui demande, donc tout le reste est refusé", reading.includes("--permission-mode manual"))
  check("codex y est en lecture seule aussi", codexArgs("read").includes("--sandbox read-only"))

  // YOLO : aucune limite, et c'est le seul niveau où le bac à sable de codex
  // tombe.
  check("**YOLO ne demande rien à personne**", claudeArgs("yolo").includes("--dangerously-skip-permissions"))
  check("et codex y perd son bac à sable", codexArgs("yolo").includes("--dangerously-bypass-approvals-and-sandbox"))
  check(
    "ce qui n'arrive à aucun autre niveau",
    !["read", "ask", "project"].some((p) => codexArgs(p).includes("--dangerously-bypass")),
  )
}

// ---- de quel champ vient l'identifiant ---------------------------------
check("claude l'appelle session_id", sessionIn({ type: "system", session_id: ID }) === ID)
check("codex l'appelle thread_id", sessionIn({ type: "thread.started", thread_id: ID }) === ID)
check("un événement sans identifiant n'en invente pas", sessionIn({ type: "assistant" }) === null)
check("une chaîne vide n'est pas un identifiant", sessionIn({ session_id: "" }) === null)
check("un identifiant qui n'est pas une chaîne est refusé", sessionIn({ session_id: 42 }) === null)

// ---- le modèle -----------------------------------------------------------
//
// Épingler un modèle ne doit jamais déloger la reprise de session, et une case
// laissée vide ne doit pas devenir `--model ""` — que le CLI prend pour une
// valeur et refuse, donnant un échec pour un champ auquel personne n'a touché.
const claudePinned = argsFor("claude", ctx, ID, "sonnet")
check("claude reçoit --model", claudePinned.includes("--model"))
check("avec la valeur juste après", claudePinned[claudePinned.indexOf("--model") + 1] === "sonnet")
check("et la session est toujours reprise", claudePinned[claudePinned.indexOf("--resume") + 1] === ID, claudePinned.join(" "))

const codexPinned = argsFor("codex", ctx, ID, "gpt-5")
check("codex reçoit --model", codexPinned[codexPinned.indexOf("--model") + 1] === "gpt-5")
check(
  "et son identifiant reste le dernier argument",
  codexPinned[codexPinned.length - 1] === ID,
  codexPinned.join(" ")
)
check(
  "resume reste la sous-commande, avant toute option",
  codexPinned[0] === "exec" && codexPinned[1] === "resume" && codexPinned.indexOf("--model") > 1,
  codexPinned.join(" ")
)

for (const empty of [null, "", "   "]) {
  check(
    `un modèle ${JSON.stringify(empty)} n'ajoute pas --model`,
    !argsFor("claude", ctx, null, empty).includes("--model") &&
      !argsFor("codex", ctx, null, empty).includes("--model")
  )
}
check("un modèle entouré d'espaces est nettoyé", argsFor("claude", ctx, null, "  opus ").includes("opus"))

// ---- quel modèle a réellement tourné --------------------------------------
check("il est lu sur l'événement d'initialisation", modelIn({ type: "system", subtype: "init", model: "claude-opus-5[1m]" }) === "claude-opus-5[1m]")
check("à défaut, sur l'usage rapporté à la fin", modelIn({ type: "result", modelUsage: { "claude-opus-5[1m]": {} } }) === "claude-opus-5[1m]")
check("un événement muet n'invente pas de nom", modelIn({ type: "assistant" }) === null)
check("une chaîne vide n'est pas un nom", modelIn({ model: "  " }) === null)

// ---- les alias, lus dans l'aide du CLI ------------------------------------
//
// Écrits ici, ils seraient une deuxième liste : un alias nouveau
// n'apparaîtrait jamais dans le menu, un alias retiré y resterait et
// échouerait. Le texte ci-dessous est celui que `claude --help` imprime.
const HELP = `  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').`
check("les alias sortent de l'aide", aliasesFrom(HELP).join(",") === "fable,opus,sonnet", aliasesFrom(HELP).join(","))
check("une aide sans alias ne fabrique rien", aliasesFrom("Usage: codex [OPTIONS]").length === 0)
check("une aide vide non plus", aliasesFrom("").length === 0)

// ---- les images -----------------------------------------------------------
//
// Les deux CLI ne les prennent pas de la même façon, et c'est relevé sur les
// binaires : codex a `-i <FILE>...`, claude n'a aucun drapeau et lit l'image
// par son chemin avec son outil Read. Se tromper de côté ne produit pas
// d'erreur — claude ignorerait un `-i` inconnu ou refuserait de démarrer, et
// codex décrirait une liste de chemins au lieu de regarder les images.
const IMAGES = ["/tmp/a.png", "/tmp/b.png"]

const claudeImages = argsFor("claude", ctx, null, null, IMAGES)
check("claude ne reçoit pas -i", !claudeImages.includes("-i"), claudeImages.join(" "))
check("et pas de chemin d'image en argument", !claudeImages.some((a) => IMAGES.includes(a)))
// Les outils de claude sont confinés au répertoire de travail, et les pièces
// jointes vivent ailleurs. Sans --add-dir, il répond « la permission a été
// refusée » pour un fichier qu'on vient de lui donner — c'est ce qu'il a fait
// au premier essai réel.
check("le dossier des images lui est ouvert", claudeImages.includes("--add-dir"), claudeImages.join(" "))
check("un seul --add-dir par dossier, pas par fichier", claudeImages.filter((a) => a === "/tmp").length === 1, claudeImages.join(" "))
check("sans image, on n'ouvre rien", !argsFor("claude", ctx, null, null, []).includes("--add-dir"))

const withPaths = promptWith("claude", "regarde ça", IMAGES)
check("les chemins arrivent à claude par le message", IMAGES.every((p) => withPaths.includes(p)))
check("avec une consigne de les lire", /Read tool/.test(withPaths), withPaths)
check("sans image, le message n'est pas touché", promptWith("claude", "bonjour", []) === "bonjour")

const codexImages = argsFor("codex", ctx, null, null, IMAGES)
check("codex reçoit un -i par image", codexImages.filter((a) => a === "-i").length === 2, codexImages.join(" "))
check("chaque -i est suivi de son chemin", codexImages[codexImages.indexOf("-i") + 1] === IMAGES[0])
check("codex ne se voit pas répéter les chemins dans le texte", promptWith("codex", "regarde ça", IMAGES) === "regarde ça")

const codexBoth = argsFor("codex", ctx, ID, "gpt-5", IMAGES)
check(
  "avec reprise, l'identifiant reste le dernier argument malgré les images",
  codexBoth[codexBoth.length - 1] === ID,
  codexBoth.join(" ")
)

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? "\nSession, modèle et images sont passés aux deux CLI comme ils l'attendent." : `\n${failures} vérification(s) en échec.`)
process.exit(failures === 0 ? 0 : 1)
