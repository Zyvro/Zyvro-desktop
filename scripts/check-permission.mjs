// Ce que l'agent a le droit de faire, et où ce choix est retenu.
//
// Ce qui casse en silence ici :
//
// 1. **Un niveau oublié.** Choisir « YOLO » puis le voir revenir à autre chose
//    à la conversation suivante, c'est un réglage qu'on remet dix fois par
//    jour — ou qu'on croit avoir mis.
//
// 2. **Un niveau qui déborde.** Le choix appartient à un dossier. S'il fuit
//    vers le projet d'à côté, un agent obtient dans l'un ce qu'on lui a accordé
//    dans l'autre.
//
// 3. **Une valeur abîmée qui accorde tout.** Ce qui est lu vient d'un stockage
//    que n'importe quoi peut écrire. Une valeur qu'on ne reconnaît pas doit
//    retomber sur le défaut, jamais sur le niveau le plus ouvert.
//
//     node scripts/check-permission.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-permission-check")
mkdirSync(dir, { recursive: true })

writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/renderer/state/permission").replace(/\\/g, "/")}"\n` +
    `export { PERMISSIONS, DEFAULT_PERMISSION } from "${path.join(ROOT, "src/shared/permission").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
})

// Un faux stockage, comme celui du navigateur de l'application.
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  },
}

const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

const A = "/tmp/projet-a"
const B = "/tmp/projet-b"

// ---- le défaut ----------------------------------------------------------
check("**sans rien de choisi, c'est le défaut**", mod.permissionFor(A) === mod.DEFAULT_PERMISSION, mod.permissionFor(A))
check("et le défaut est le projet entier, pas YOLO", mod.DEFAULT_PERMISSION === "project", mod.DEFAULT_PERMISSION)

// ---- il est retenu ------------------------------------------------------
{
  let woken = 0
  const stop = mod.subscribePermission(() => woken++)
  mod.setPermissionFor(A, "yolo")
  check("**ce qu'on choisit est ce qu'on relit**", mod.permissionFor(A) === "yolo")
  check("et le panneau est réveillé", woken === 1, String(woken))
  stop()

  // Écrit sous une clé qui nomme le dossier : c'est ce qui le rend propre à ce
  // projet, et ce qui permet de le retrouver au prochain démarrage.
  const written = [...store.entries()].find(([k]) => k.includes(A))
  check("**il est écrit avec le dossier dans sa clé**", Boolean(written), JSON.stringify([...store.keys()]))
  check("avec la valeur choisie", written?.[1] === "yolo", String(written?.[1]))
}

// ---- il ne déborde pas --------------------------------------------------
check("**le projet d'à côté garde le défaut**", mod.permissionFor(B) === mod.DEFAULT_PERMISSION, mod.permissionFor(B))
mod.setPermissionFor(B, "read")
check("chacun le sien", mod.permissionFor(A) === "yolo" && mod.permissionFor(B) === "read")

// ---- une valeur abîmée --------------------------------------------------
{
  // Le stockage appartient au navigateur de l'application : ce qui en sort
  // n'est pas forcément ce qu'on y a mis.
  const C = "/tmp/projet-c"
  store.set(`zyvro.permission:${C}`, "bypass-everything")
  check(
    "**une valeur inconnue retombe sur le défaut**",
    mod.permissionFor(C) === mod.DEFAULT_PERMISSION,
    mod.permissionFor(C)
  )
}

// ---- un stockage qui refuse ---------------------------------------------
{
  const D = "/tmp/projet-d"
  const kept = globalThis.window.localStorage
  globalThis.window.localStorage = {
    getItem() {
      throw new Error("refusé")
    },
    setItem() {
      throw new Error("refusé")
    },
  }
  let threw = false
  try {
    mod.setPermissionFor(D, "ask")
    check("un stockage qui refuse ne perd pas le choix de la session", mod.permissionFor(D) === "ask")
  } catch (err) {
    threw = String(err)
  }
  check("**et ne fait pas tomber le panneau**", threw === false, String(threw))
  globalThis.window.localStorage = kept
}

console.log(
  failures === 0
    ? "\nCe qu'un agent a le droit de faire est retenu par dossier, et une valeur qu'on ne reconnaît pas n'accorde rien."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
