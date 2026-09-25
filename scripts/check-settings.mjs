// Les réglages de l'éditeur, et la sauvegarde automatique.
//
// Ce qui casse en silence ici :
//
// 1. **Une valeur abîmée dans le stockage.** Une ancienne version, une main
//    maladroite : une police à 0 ou une tabulation à 400 donnent un éditeur
//    inutilisable, et rien ne dit pourquoi. On relit en bornant.
//
// 2. **Un réglage qui ne prend effet qu'au fichier suivant.** Les mêmes
//    options à la création et au changement, appliquées aux éditeurs ouverts.
//
// 3. **La sauvegarde automatique allumée par défaut.** Écrire sur le disque
//    sans qu'on le demande est un choix, pas une découverte.
//
//     node scripts/check-settings.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-settings-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${rel("src/shared/settings")}"\nexport * from "${rel("src/renderer/state/settings")}"\n`
)
// Un stockage de fenêtre, avec une valeur abîmée déjà dedans.
const stockage = new Map([["zyvro.editorSettings", JSON.stringify({ fontSize: 0, tabSize: 400, wordWrap: "maybe", minimap: true })]])
globalThis.localStorage = {
  getItem: (k) => stockage.get(k) ?? null,
  setItem: (k, v) => stockage.set(k, String(v)),
}
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

{
  const lu = t.getSettings()
  check("**une police à 0 est ramenée au minimum**", lu.fontSize === 8, String(lu.fontSize))
  check("une tabulation à 400 au maximum", lu.tabSize === 8)
  check("une valeur inconnue revient au défaut", lu.wordWrap === "off")
  check("et ce qui était juste est gardé", lu.minimap === true)
  check("**la sauvegarde automatique est éteinte par défaut**", t.DEFAULT_SETTINGS.autoSave === "off")
  check("rien de lisible : les défauts", JSON.stringify(t.sanitizeSettings("n'importe quoi")) === JSON.stringify(t.DEFAULT_SETTINGS))
  check("un délai de 0 ms n'écrirait qu'à chaque frappe : borné", t.sanitizeSettings({ autoSaveDelay: 0 }).autoSaveDelay === 200)
  check("la hauteur de ligne suit la police", t.lineHeightFor(13) === 20 && t.lineHeightFor(20) > 28)
}
{
  let prevenu = 0
  t.subscribeSettings(() => prevenu++)
  t.updateSettings({ fontSize: 16 })
  check("**un changement prévient les éditeurs ouverts**", prevenu === 1 && t.getSettings().fontSize === 16)
  check("et se garde sur cette machine", JSON.parse(stockage.get("zyvro.editorSettings")).fontSize === 16)
  t.resetSettings()
  check("« Reset » revient aux défauts", JSON.stringify(t.getSettings()) === JSON.stringify(t.DEFAULT_SETTINGS))
}
{
  const editeur = readFileSync(path.join(ROOT, "src/renderer/panels/CodeEditor.tsx"), "utf8")
  check("**les mêmes options à la création et au changement**", (editeur.match(/optionsFrom\(/g) ?? []).length >= 3)
  check("plus de police écrite en dur", !/fontSize: 13,/.test(editeur))
  check("la sauvegarde après un délai", /r\.autoSave !== "afterDelay"/.test(editeur) && /setTimeout\(sauverSiModifie, r\.autoSaveDelay\)/.test(editeur))
  check("et à la perte du focus, fenêtre comprise", /onDidBlurEditorText\(perdFocus\)/.test(editeur) && /addEventListener\("blur", perdFocus\)/.test(editeur))
  check("seulement ce qui a un brouillon", /if \(modifie\(\)\) void save\(true\)/.test(editeur))
  const menu = readFileSync(path.join(ROOT, "src/main/index.ts"), "utf8")
  check("⌘, ouvre les réglages", /label: "Settings…",\s*accelerator: "CmdOrCtrl\+,"/.test(menu))
}

if (failures) {
  console.log(`\n${failures} échec(s)`)
  process.exit(1)
}
console.log("\nLes réglages se lisent sans surprise et s'appliquent tout de suite.")
