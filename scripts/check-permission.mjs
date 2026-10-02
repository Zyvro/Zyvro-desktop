// Ce que l'agent a le droit de faire, et où ce choix est retenu.
//
// Ce qui casse en silence ici :
//
// 1. **Un niveau oublié.** Choisir « YOLO » puis le voir revenir à autre chose,
//    c'est un réglage qu'on remet dix fois par jour — ou qu'on croit avoir mis.
//    Il a été oublié deux fois, pour deux raisons différentes : d'abord à
//    chaque nouvelle conversation, puis à chaque changement de projet. Ce
//    niveau ne décrit ni une phrase ni un dossier, il décrit quelqu'un.
//
// 2. **Un niveau qui déborde vers le haut.** La version d'avant retenait une
//    valeur par dossier. Reprendre un « YOLO » choisi pour un seul projet comme
//    réglage valable partout élargirait un droit que personne n'a élargi.
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

// Un faux stockage, comme celui du navigateur de l'application. `length` et
// `key()` en font partie : c'est par eux qu'on retrouve les clés de la version
// d'avant pour les effacer.
const store = new Map()
const fakeStorage = () => ({
  get length() {
    return store.size
  },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
})
globalThis.window = { localStorage: fakeStorage() }

const load = () => {
  const require = createRequire(import.meta.url)
  delete require.cache[path.join(dir, "h.cjs")]
  return require(path.join(dir, "h.cjs"))
}
let mod = load()

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// ---- le défaut ----------------------------------------------------------
check("**sans rien de choisi, c'est le défaut**", mod.permission() === mod.DEFAULT_PERMISSION, mod.permission())
check("et le défaut est le projet entier, pas YOLO", mod.DEFAULT_PERMISSION === "project", mod.DEFAULT_PERMISSION)

// ---- il est retenu ------------------------------------------------------
{
  let woken = 0
  const stop = mod.subscribePermission(() => woken++)
  mod.setPermission("yolo")
  check("**ce qu'on choisit est ce qu'on relit**", mod.permission() === "yolo")
  check("et le panneau est réveillé", woken === 1, String(woken))
  stop()
}

// ---- il ne dépend d'aucun projet ----------------------------------------
//
// Structurel plutôt que testé par comparaison : l'ancienne interface prenait un
// dossier en argument, et tant qu'elle existe quelqu'un peut la rappeler.
check("**le choix ne prend pas de projet**", mod.permissionFor === undefined && mod.setPermissionFor === undefined)
check("il se lit sans rien lui donner", mod.permission.length === 0, `arité : ${mod.permission.length}`)
{
  const clefs = [...store.keys()]
  check("**il est écrit sous une seule clé**", clefs.length === 1, JSON.stringify(clefs))
  check("qui ne nomme aucun dossier", clefs[0] === "zyvro.permission", clefs[0])
  check("avec la valeur choisie", store.get("zyvro.permission") === "yolo", String(store.get("zyvro.permission")))
}

// ---- les clés de la version d'avant -------------------------------------
{
  store.clear()
  store.set("zyvro.permission:/tmp/projet-a", "yolo")
  store.set("zyvro.permission:/tmp/projet-b", "read")
  mod = load()
  check("**un YOLO d'un seul dossier n'est pas promu partout**", mod.permission() === mod.DEFAULT_PERMISSION, mod.permission())
  check(
    "et les clés par dossier sont effacées",
    [...store.keys()].every((k) => !k.startsWith("zyvro.permission:")),
    JSON.stringify([...store.keys()])
  )
}

// ---- une valeur abîmée --------------------------------------------------
{
  // Le stockage appartient au navigateur de l'application : ce qui en sort
  // n'est pas forcément ce qu'on y a mis.
  store.clear()
  store.set("zyvro.permission", "bypass-everything")
  mod = load()
  check("**une valeur inconnue retombe sur le défaut**", mod.permission() === mod.DEFAULT_PERMISSION, mod.permission())
}

// ---- un stockage qui refuse ---------------------------------------------
{
  store.clear()
  mod = load()
  globalThis.window.localStorage = {
    get length() {
      throw new Error("refusé")
    },
    key() {
      throw new Error("refusé")
    },
    getItem() {
      throw new Error("refusé")
    },
    setItem() {
      throw new Error("refusé")
    },
    removeItem() {
      throw new Error("refusé")
    },
  }
  let threw = false
  try {
    mod.setPermission("ask")
    check("un stockage qui refuse ne perd pas le choix de la session", mod.permission() === "ask")
  } catch (err) {
    threw = String(err)
  }
  check("**et ne fait pas tomber le panneau**", threw === false, String(threw))
  globalThis.window.localStorage = fakeStorage()
}

console.log(
  failures === 0
    ? "\nCe qu'un agent a le droit de faire est une préférence de la personne, la même partout, et une valeur qu'on ne reconnaît pas n'accorde rien."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
