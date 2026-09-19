// Un graphe lancé sur un dossier.
//
// Le moteur sait répéter depuis le 19/09 : `POST /api/batches` prend un dossier
// et enchaîne une exécution par fichier. Ce garde tient le côté fenêtre, et
// surtout les trois choses qui s'y cassent en silence.
//
// 1. **Un lot qu'on ne retrouve plus.** Un lot ne vit pas dans cette page : il
//    tourne dans le moteur et survit à la fermeture de l'onglet. Mesuré avant
//    d'être corrigé — onglet fermé puis rouvert pendant un lot de 365 fichiers,
//    et les 365 continuaient de s'écrire sans une ligne à l'écran. C'est la
//    panne des boucles d'agent, mot pour mot : « de vrais tours tournaient, et
//    l'écran ne bougeait pas d'une ligne ». Elle coûte des appels de modèle que
//    personne ne voit passer, et elle rend irreprenable un lot cassé au 300e,
//    ce qui vide de son sens le seul arbitrage qui comptait.
//
// 2. **Un champ que l'un envoie et que l'autre ne lit pas.** Si `match` cesse
//    d'être transmis, le lot ne refuse rien : il tourne sur *tous* les fichiers
//    du dossier. Un `node_modules` au lieu de `sprites/abyssal`, et la facture
//    est faite avant que quiconque regarde.
//
// 3. **La valeur du lot écrasée par une valeur fixe.** L'entrée pilotée est
//    remplie fichier par fichier ; l'envoyer aussi dans les entrées partagées
//    la fixerait pour les 519 exécutions.
//
//     node scripts/check-batch.mjs
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const apiTs = path.resolve(ROOT, "../Zyvro-frontend/src/lib/api.ts")
const hooksTs = path.resolve(ROOT, "../Zyvro-frontend/src/lib/hooks.ts")
const builderTsx = path.resolve(ROOT, "../Zyvro-frontend/src/components/Builder.tsx")
const batchGo = path.resolve(ROOT, "../Zyvro-engine/cmd/zyvrod/batch.go")

for (const [quoi, ou] of [
  ["api.ts du front", apiTs],
  ["hooks.ts du front", hooksTs],
  ["Builder.tsx du front", builderTsx],
  ["batch.go du moteur", batchGo],
]) {
  if (!existsSync(ou)) {
    console.log(`ignoré : ${quoi} n'est pas à côté de ce dépôt (${ou})`)
    process.exit(0)
  }
}

const api = readFileSync(apiTs, "utf8")
const hooks = readFileSync(hooksTs, "utf8")
const builder = readFileSync(builderTsx, "utf8")
const go = readFileSync(batchGo, "utf8")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- le moteur et la fenêtre parlent des mêmes champs --------------------
{
  const debut = go.indexOf("type batchRequest struct {")
  const struct = go.slice(debut, go.indexOf("\n}", debut))
  const lus = new Set([...struct.matchAll(/`json:"([^",]+)"/g)].map((m) => m[1]))
  lus.add("workflow_id") // porté par le handler, pas par la structure
  check("**le moteur déclare les champs d'un lot**", lus.size > 5, [...lus].join(","))

  const fn = api.slice(api.indexOf("runBatch:"), api.indexOf("getBatch:"))
  // Jusqu'au bout de la fonction : le premier « }), » venu tombe au milieu du
  // premier champ conditionnel, et la moitié des clefs manquerait sans qu'on
  // le sache — c'est arrivé en écrivant ce garde.
  const corps = fn.slice(fn.indexOf("JSON.stringify({"))
  const envoyes = [...corps.matchAll(/(?:^\s*|\{\s*)([a-z][a-z0-9_]*):\s/gm)].map((m) => m[1])
  check("**et la fenêtre en envoie au moins autant qu'il en faut**", envoyes.length >= 6, envoyes.join(","))
  const inconnus = envoyes.filter((k) => !lus.has(k))
  check(
    "**aucun champ envoyé que le moteur ne lise**",
    inconnus.length === 0,
    `${inconnus.join(", ")} — un lot ne refuserait rien, il tournerait sur tout le dossier`
  )
  // Les deux qui décident de la dépense : sans eux, « ce dossier-ci » devient
  // « tout ce qu'il y a ».
  for (const clef of ["dir", "match", "input"]) {
    check(`et « ${clef} » part bien`, envoyes.includes(clef), corps.slice(0, 200))
  }
}

// ---- un lot en cours se retrouve tout seul -------------------------------
{
  check(
    "**la fenêtre sait demander les lots d'un workflow**",
    /export function useWorkflowBatches\(/.test(hooks),
    "un lot lancé puis quitté n'aurait plus aucun moyen d'être retrouvé"
  )
  check(
    "**et l'éditeur reprend celui qui tourne encore**",
    /const liveBatch = rows\.find\(\(b\) => b\.status === "queued" \|\| b\.status === "running"\)/.test(builder) &&
      /if \(batchId === null && liveBatch && adoptedBatch\.current !== liveBatch\.id\)/.test(builder),
    "365 fichiers continuaient de s'écrire sans une ligne à l'écran — mesuré"
  )
  // Sans le repère, un lot refermé à la main se rouvrirait au rendu suivant.
  check(
    "et un lot refermé ne se rouvre pas tout seul",
    /adoptedBatch\.current = liveBatch\.id/.test(builder)
  )
  // Et il reste atteignable une fois fini, sans quoi « reprendre » n'existe
  // que tant qu'on n'a pas fermé l'onglet.
  check(
    "**et celui d'avant reste ouvrable**",
    /last: batchId === null && lastBatch \? lastBatch : undefined/.test(builder) && /Last: \{/.test(builder),
    "un lot cassé au 300e serait irreprenable dès qu'on change d'onglet"
  )
  // Le sondage doit survivre à une fenêtre qui n'est pas au premier plan : un
  // lot est exactement la chose qu'on lance avant d'aller faire autre chose,
  // et macOS tient pour cachée une fenêtre simplement recouverte.
  const occurrences = hooks.split("refetchIntervalInBackground: true").length - 1
  check(
    "**et il compte encore quand la fenêtre n'est pas devant**",
    occurrences >= 2,
    "le compteur restait à « 0 sur 4 » alors que les quatre fichiers étaient écrits"
  )
}

// ---- ce que l'on n'envoie pas -------------------------------------------
{
  const envoi = builder.slice(builder.indexOf("async function startBatch()"))
  const corps = envoi.slice(0, envoi.indexOf("const batchDraft"))
  check(
    "**l'entrée pilotée n'est pas envoyée en valeur fixe**",
    /if \(def\.key === batchInput\) continue/.test(corps),
    "elle serait la même pour les 519 exécutions"
  )
  check(
    "et le graphe est sauvé avant de partir",
    corps.indexOf("api.updateWorkflow") < corps.indexOf("api.runBatch"),
    "519 exécutions du graphe d'hier seraient 519 fichiers à refaire"
  )
}

// ---- ce qui ne s'affiche pas --------------------------------------------
{
  check(
    "**le lot n'est proposé que là où il y a un dossier de projet**",
    /const canBatch = Boolean\(hostCapabilities\(\)\.pickProjectFile\)/.test(builder),
    "le web proposerait de lancer un graphe sur un dossier qui n'existe pas"
  )
  check(
    "et la liste des lots n'est même pas demandée ailleurs",
    /useWorkflowBatches\(canBatch \? workflow\?\.id : undefined\)/.test(builder),
    "l'API hébergée prendrait un 404 par éditeur ouvert"
  )
}

// ---- reprendre est le défaut --------------------------------------------
{
  check(
    "**reprendre est le défaut, recommencer se dit**",
    /retryBatch: \(id: string, restart = false\)/.test(api),
    "un clic malheureux relancerait 519 exécutions déjà payées"
  )
  check(
    "et le bouton ne s'offre que s'il reste quelque chose",
    /left > 0 &&/.test(builder),
    "« Resume 0 » sur un lot terminé"
  )
  check(
    "**et on ne peut pas fermer la fenêtre d'un lot qui tourne**",
    /\{!live && \(/.test(builder),
    "le seul endroit qui montre le lot, refermable pendant qu'il dépense"
  )
}

// ---- une seule façon de compter, et une seule colonne --------------------
{
  const appels = builder.split("batchSummary(").length - 1
  check(
    "**une seule phrase compte les éléments**",
    /function batchSummary\(c: BatchCounts\)/.test(builder) && appels >= 3,
    "deux façons de compter les mêmes éléments finiraient par ne pas dire la même chose"
  )

  // Les deux panneaux de droite. Posés chacun en absolu, ils se recouvraient de
  // cent pixels dans un onglet d'éditeur et le bouton « Run over the folder »
  // passait dessous, incliquable — `elementFromPoint` rendait le compteur.
  check(
    "**et les deux panneaux partagent une colonne, pas un coin**",
    builder.includes('className="pointer-events-none absolute bottom-3 right-3 top-16 z-40 flex w-96 flex-col gap-2"'),
    "le bouton du panneau de run repasse sous le panneau du lot"
  )
  for (const [quoi, ancre] of [
    ["run", 'const missing = defs.filter'],
    ["lot", "const { batch: b, counts: c } = data"],
  ]) {
    const depuis = builder.indexOf(ancre)
    const racine = builder.slice(depuis, depuis + 900).match(/className="panel[^"]*"/)
    check(
      `le panneau de ${quoi} ne se pose plus en absolu`,
      racine !== null && !racine[0].includes("absolute"),
      racine ? racine[0] : "racine introuvable"
    )
  }
}

console.log(
  failures === 0
    ? "\nUn lot se retrouve après un onglet refermé, ne s'offre que là où il y a un dossier, et reprend ce qui reste."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
