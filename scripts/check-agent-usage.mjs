// Ce qu'une réponse a dépensé.
//
// Ce qui casse en silence ici :
//
// 1. **« Entrée » veut dire trois choses.** Avec le cache de prompt,
//    `input_tokens` vaut deux ou trois : ce sont les jetons frais. Le contexte
//    entier — dix mille, trente mille — arrive par `cache_read_input_tokens`.
//    Afficher le premier seul annoncerait « 2 » pour un tour qui en a fait
//    traverser vingt-sept mille, et personne ne saurait que c'est faux.
//
// 2. **Un événement sans chiffres.** Tous les tours n'en portent pas. Écrire
//    « 0 in · 0 out » sous une réponse est pire que ne rien écrire : ça a l'air
//    d'une mesure.
//
// 3. **L'abrégé.** « 27k » doit rester du même ordre de grandeur que 27 000, et
//    l'exact doit rester atteignable — c'est l'infobulle qui le porte.
//
// La charge utile employée ici est celle que `claude -p --output-format
// stream-json` a réellement émise sur cette machine, pas une reconstitution.
//
//     node scripts/check-agent-usage.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-usage-check")
mkdirSync(dir, { recursive: true })

writeFileSync(path.join(dir, "electron.js"), `module.exports = { app: {}, BrowserWindow: {} }\n`)
writeFileSync(
  path.join(dir, "h.ts"),
  `export { usageIn } from "${path.join(ROOT, "src/main/agent").replace(/\\/g, "/")}"\n` +
    `export { compact, detail } from "${path.join(ROOT, "src/renderer/lib/usage").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js"), "~": path.join(ROOT, "src/renderer") },
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

// ---- ce que le CLI émet vraiment ----------------------------------------
//
// Relevé sur `claude -p --output-format stream-json "dis juste OK"` : deux
// jetons frais, seize mille sept cents mis en cache, dix mille relus, quatre
// en sortie.
const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  total_cost_usd: 0.17348900000000003,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 16736,
    cache_read_input_tokens: 10126,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0 },
  },
}

{
  const spent = mod.usageIn(RESULT)
  check("**l'entrée compte le cache, pas seulement le frais**", spent.input === 2 + 16736 + 10126, String(spent?.input))
  check("et la sortie est la sortie", spent.output === 4, String(spent?.output))
  check("la part relue est gardée à part", spent.cacheRead === 10126)
  check("la part écrite aussi", spent.cacheWrite === 16736)
  check("le coût annoncé est repris tel quel", Math.abs(spent.costUsd - 0.173489) < 1e-9, String(spent?.costUsd))

  // Le piège du naïf : `input_tokens` seul dirait deux.
  check(
    "**un tour de vingt-sept mille jetons ne s'annonce pas comme deux**",
    spent.input > 26000,
    `${spent.input} annoncés`
  )
}

// ---- ce qui n'est pas une dépense ---------------------------------------
{
  check("**un événement sans usage ne rend rien**", mod.usageIn({ type: "result" }) === null)
  check("un usage vide non plus", mod.usageIn({ usage: {} }) === null)
  check(
    "et des zéros ne sont pas une mesure",
    mod.usageIn({ usage: { input_tokens: 0, output_tokens: 0 } }) === null
  )
  check(
    "un compte absurde est ignoré plutôt que affiché",
    mod.usageIn({ usage: { input_tokens: -5, output_tokens: 3 } }).input === 0
  )
  check("un coût absent laisse le coût absent", mod.usageIn({ usage: { output_tokens: 3 } }).costUsd === null)
}

// ---- l'abrégé -----------------------------------------------------------
{
  const cas = [
    [0, "0"],
    [999, "999"],
    [1000, "1k"],
    [1500, "1.5k"],
    [26864, "27k"],
    [1_240_000, "1.2M"],
  ]
  for (const [valeur, attendu] of cas) {
    check(`${valeur} s'écrit ${attendu}`, mod.compact(valeur) === attendu, mod.compact(valeur))
  }
}

// ---- ce que l'infobulle dit ---------------------------------------------
{
  const texte = mod.detail(mod.usageIn(RESULT))
  check("**l'infobulle donne le compte exact**", texte.includes("26,864") && texte.includes("4 out"), texte)
  check("elle distingue le frais du relu", texte.includes("2 new") && texte.includes("10,126 read from cache"), texte)
  check("et ce qui a été mis en cache", texte.includes("16,736 written to cache"), texte)
  check("le coût y est, à quatre décimales", texte.includes("$0.1735"), texte)

  const sansCache = mod.detail({ input: 120, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: null })
  check("**sans cache, elle ne parle pas de cache**", !sansCache.includes("cache"), sansCache)
  check("et sans coût annoncé, elle n'en invente pas", !sansCache.includes("$"), sansCache)
}

console.log(
  failures === 0
    ? "\nCe qu'une réponse a dépensé se lit tel que le CLI l'a rapporté, cache compris."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
