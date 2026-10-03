// Les thèmes du chat, l'indicateur, et le fichier de réglages.
//
// Demandé par Jeremy : choisir le thème du chat d'agent et l'icône qui tourne
// pendant qu'il écrit — la sienne comprise — et une configuration en JSON qu'on
// exporte, importe et retrouve dans un fichier. Ce qui casse en silence : un
// thème qui oublie une variable (il garde la couleur du précédent), une image
// « à soi » qui serait autre chose qu'une image, un fichier exporté qu'on ne
// sait pas relire, et le bouton du bas qui rouvrirait Providers.
//
//     node scripts/check-chat-themes.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-chat-themes-check")
mkdirSync(dir, { recursive: true })
const rel = (p) => path.join(ROOT, p).replace(/\\/g, "/")
writeFileSync(path.join(dir, "electron.js"), "module.exports = { app: { getPath: () => '/tmp' } }\n")
await build({
  stdin: {
    contents:
      `export * from "${rel("src/shared/chatThemes")}"\n` +
      `export { sanitizeSettings, DEFAULT_SETTINGS } from "${rel("src/shared/settings")}"\n` +
      `export { wrap, unwrap } from "${rel("src/main/settingsFile")}"\n`,
    resolveDir: ROOT,
  },
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  logLevel: "silent",
})
const t = createRequire(import.meta.url)(path.join(dir, "h.cjs"))
const lire = (p) => readFileSync(path.join(ROOT, p), "utf8")

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- les thèmes ----
check("plusieurs thèmes, Zyvro en premier", t.CHAT_THEMES.length >= 5 && t.CHAT_THEMES[0].id === "zyvro")
for (const theme of t.CHAT_THEMES) {
  const manque = t.CHAT_VARS.filter((v) => !theme.vars[v])
  check(`**${theme.label} donne toutes ses couleurs**`, manque.length === 0, manque.join(", "))
}
check("un thème inconnu revient à Zyvro", t.chatTheme("nope").id === "zyvro")
check("**le thème est un réglage, relu et nettoyé**", t.sanitizeSettings({ chatTheme: "dracula" }).chatTheme === "dracula" && t.sanitizeSettings({ chatTheme: "<script>" }).chatTheme === "zyvro")

// ---- l'indicateur ----
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
check("une image PNG est acceptée", t.sanitizeCustomIndicator({ dataUrl: png, name: "a.png", animation: "spin" })?.animation === "spin")
check("**une adresse qui n'est pas une image est refusée**", t.sanitizeCustomIndicator({ dataUrl: "javascript:alert(1)" }) === null && t.sanitizeCustomIndicator({ dataUrl: "data:text/html;base64,PGI+" }) === null)
check("une image trop lourde aussi", t.sanitizeCustomIndicator({ dataUrl: `data:image/png;base64,${"A".repeat(t.CUSTOM_INDICATOR_MAX)}` }) === null)
check("une animation inconnue devient « spin »", t.sanitizeCustomIndicator({ dataUrl: png, animation: "explode" })?.animation === "spin")
check("**« Your own » sans image retombe sur l'étoile**", t.sanitizeSettings({ workingIndicator: "custom" }).workingIndicator === "sparkle")
check("et avec une image, la garde", t.sanitizeSettings({ workingIndicator: "custom", customIndicator: { dataUrl: png } }).workingIndicator === "custom")
check("par défaut : le thème Zyvro, l'étoile, pas d'image", t.DEFAULT_SETTINGS.chatTheme === "zyvro" && t.DEFAULT_SETTINGS.workingIndicator === "sparkle" && t.DEFAULT_SETTINGS.customIndicator === null)

// ---- le fichier ----
const enveloppe = t.wrap({ chatTheme: "ocean" })
check("**un fichier exporté se relit**", t.unwrap(JSON.parse(JSON.stringify(enveloppe))).chatTheme === "ocean" && enveloppe.app === "zyvro-studio")
check("et un objet de réglages nu aussi", t.unwrap({ chatTheme: "mono" }).chatTheme === "mono")
const etat = lire("src/renderer/state/settings.ts")
check("**chaque changement est écrit dans le fichier**", /versLeFichier\(\)/.test(etat) && /fichier\.write\(courant\)/.test(etat))
check("et le fichier relu au démarrage gagne", /replaceSettings\(depuisLeFichier\)/.test(etat))
const ipc = lire("src/main/ipc.ts")
check("export et import passent par de vraies boîtes de dialogue", /"settings:export"[\s\S]{0,400}showSaveDialog/.test(ipc) && /"settings:import"[\s\S]{0,400}showOpenDialog/.test(ipc))

// ---- le chat ne connaît que les variables ----
const tool = lire("src/renderer/panels/ToolRow.tsx")
check("**les outils prennent leur couleur du thème**", /read: "text-\[color:var\(--zy-tool-read\)\]"/.test(tool) && !/read: "text-sky-300"/.test(tool))
const couleurs = lire("src/renderer/lib/chatColors.tsx")
check("le code aussi", /--zy-syn-keyword/.test(couleurs) && !/text-\[#a78bfa\]/.test(couleurs))
check("et l'indicateur suit le style choisi", /<WorkingGlyph variant=\{reglages\.workingIndicator\}/.test(couleurs))

// ---- la barre d'activité ----
const app = lire("src/renderer/App.tsx")
const haut = app.slice(app.indexOf("const items = ["), app.indexOf("const bottom = ["))
const bas = app.slice(app.indexOf("const bottom = ["), app.indexOf("return (", app.indexOf("const bottom = [")))
check("**Providers n'est plus sous Store**", !/label: "Providers"/.test(haut))
check("**en bas : Providers, puis Settings**", /label: "Providers"[\s\S]*label: "Settings",[\s\S]*onClick: openSettings/.test(bas))

console.log(failures === 0 ? "\nLe chat a ses thèmes, l'indicateur ses styles, et les réglages leur fichier." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
