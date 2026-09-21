// Empaqueter, avec l'environnement que la compilation native réclame.
//
// electron-builder relance sa propre reconstruction des modules natifs, par
// architecture. Sur cette machine `node-pty` ne compile pas contre le SDK que
// `xcrun` choisit par défaut — libc++ trouve le mauvais <stddef.h> et la
// compilation s'arrête :
//
//     <cstddef> tried including <stddef.h> but didn't find libc++'s <stddef.h>
//     make: *** [Release/obj.target/pty/src/unix/pty.o] Error 1
//     ⨯ node-gyp failed to rebuild 'node_modules/node-pty'
//
// mac-sdk.mjs sait déjà répondre à ça, et son commentaire dit depuis le début
// que deux endroits en ont besoin : `npm install` et l'empaquetage. Le second
// ne l'avait jamais. `npm run release` passait — il appelle electron-builder
// lui-même, avec `nativeBuildEnv()` — pendant que `npm run dist:mac` et
// `npm run pack:mac` échouaient sur la même machine, à la même ligne. Une règle
// écrite à un seul endroit et appliquée à deux : c'est ce fichier.
//
// Les arguments sont passés tels quels à electron-builder :
//
//     node scripts/pack.mjs --mac --dir --arm64
//     node scripts/pack.mjs --win nsis --x64
import { spawnSync } from "node:child_process"
import { nativeBuildEnv } from "./mac-sdk.mjs"

const args = process.argv.slice(2)

// Le nom du binaire du moteur à embarquer. Il suit la plateforme demandée, et
// il était jusqu'ici posé par `cross-env` dans la ligne du package.json — un
// second endroit où se tromper le jour où une cible s'ajoute.
const windows = args.includes("--win")
const env = { ...nativeBuildEnv(), ZYVROD_BIN: windows ? "zyvrod.exe" : "zyvrod" }

if (env.SDKROOT) process.stdout.write(`Packaging with SDKROOT=${env.SDKROOT}\n`)

const result = spawnSync("npx", ["electron-builder", ...args], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
})
process.exit(result.status ?? 1)
