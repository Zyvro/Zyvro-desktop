// Ce que la fenêtre montre quand le processus principal refuse.
//
// Electron enveloppe toute erreur qui traverse `ipcRenderer.invoke` :
//
//     Error invoking remote method 'shots:share': Error: Sign in to publish
//     to the store.
//
// Le rendu affiche `err.message` tel quel, ce qui est la bonne chose à faire —
// ces phrases sont écrites pour être lues. Le préfixe les faisait passer pour
// une trace technique : « connectez-vous pour publier » devenait un bogue.
//
// Ce qui casse en silence ici :
//
// 1. **Un appel qui contourne le pont.** Le nettoyage vit dans `invoke`. Un
//    nouvel appel écrit avec `ipcRenderer.invoke` marcherait parfaitement et
//    ramènerait le préfixe, pour lui seul, sans que rien ne le signale.
//
// 2. **Un nettoyage trop gourmand.** Une phrase qui commence par un mot en
//    « …Error » — ou une erreur qui n'a jamais traversé le pont — ne doit pas
//    être amputée.
//
// 3. **L'original perdu.** Le canal et la trace servent à qui débogue ; ils
//    quittent le message, pas l'erreur.
//
//     node scripts/check-ipc-errors.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-ipc-check")
mkdirSync(dir, { recursive: true })

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- le pont, monté sur un faux electron -------------------------------
//
// `contextBridge.exposeInMainWorld` est ce qui rend l'objet observable : le
// pont l'expose, on le retient, et on l'exerce comme le rendu l'exerce.
writeFileSync(
  path.join(dir, "electron.js"),
  `let exposed = null
   let thrown = null
   module.exports = {
     contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value } },
     ipcRenderer: {
       on() {},
       removeListener() {},
       invoke: async () => { throw thrown },
     },
     bridge: () => exposed,
     setThrown: (v) => { thrown = v },
   }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `import * as electron from "electron"\n` +
    `import "${path.join(ROOT, "src/preload/index").replace(/\\/g, "/")}"\n` +
    `export const bridge = (electron as unknown as { bridge: () => any }).bridge\n` +
    `export const setThrown = (electron as unknown as { setThrown: (v: unknown) => void }).setThrown\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  alias: { electron: path.join(dir, "electron.js") },
  absWorkingDir: ROOT,
  logLevel: "silent",
})
const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))
const zyvro = mod.bridge()
check("**le pont s'expose**", Boolean(zyvro && zyvro.project), typeof zyvro)

async function messageOf(call) {
  try {
    await call()
    return null
  } catch (err) {
    return err
  }
}

// Le cas qui a fait trouver tout ceci : partager une capture sans compte.
{
  mod.setThrown(new Error("Error invoking remote method 'shots:share': Error: Sign in to publish to the store."))
  const err = await messageOf(() => zyvro.shots.share())
  check(
    "**la phrase arrive sans le nom du canal**",
    err?.message === "Sign in to publish to the store.",
    JSON.stringify(err?.message)
  )
  check(
    "et l'original reste attaché, pour qui débogue",
    typeof err?.cause?.message === "string" && err.cause.message.includes("shots:share"),
    JSON.stringify(err?.cause?.message)
  )
}

// Le même traitement pour n'importe quel canal, pas seulement celui-là.
{
  mod.setThrown(new Error("Error invoking remote method 'git:commit': Error: nothing staged to commit"))
  const err = await messageOf(() => zyvro.git.commit("m"))
  check("**tous les canaux, pas seulement celui qu'on a vu**", err?.message === "nothing staged to commit", JSON.stringify(err?.message))
}

// Une erreur qui n'a pas traversé le pont garde son texte.
{
  mod.setThrown(new Error("the daemon is not running"))
  const err = await messageOf(() => zyvro.project.current())
  check("**ce qui n'est pas enveloppé n'est pas touché**", err?.message === "the daemon is not running", JSON.stringify(err?.message))
}

// Et une phrase qui parle d'erreurs n'est pas amputée.
{
  mod.setThrown(new Error("Error invoking remote method 'engine:status': Error: TypeError: is what the log said"))
  const err = await messageOf(() => zyvro.project.recents())
  check(
    "**on retire une enveloppe, pas un mot du texte**",
    err?.message === "TypeError: is what the log said",
    JSON.stringify(err?.message)
  )
}

// ---- personne ne contourne le pont --------------------------------------
{
  const source = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8")
  const direct = source.split("\n").filter((line) => line.includes("ipcRenderer.invoke("))
  check(
    "**un seul appel direct : celui qui nettoie**",
    direct.length === 1,
    direct.join("\n        ") || "(aucun — le nettoyage a disparu)"
  )
  check(
    "et c'est bien celui-là",
    direct[0]?.includes("return ipcRenderer.invoke(channel"),
    direct[0] ?? ""
  )
}

console.log(
  failures === 0
    ? "\nUne erreur du processus principal arrive dans la fenêtre comme une phrase."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
