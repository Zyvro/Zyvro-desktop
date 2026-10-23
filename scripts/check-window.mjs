// La fenêtre : barre de titre, boutons de macOS, place et taille retenues, et ce qui
// l'empêche de tomber.
//
// Sur macOS la barre de titre native est cachée et les trois boutons flottent au-dessus
// de la nôtre, à GAUCHE des onglets de projet. Trois nombres doivent s'accorder — la
// hauteur de la barre, la position des boutons, la place gardée avant le premier onglet —
// et ils vivaient dans trois fichiers. Et la fenêtre se rouvrait toujours pareil, ou, pire
// quand on la retient mal, hors de tout écran.
//
// Ce qui casse en silence ici :
//
// 1. **Des boutons trop hauts ou sous le premier onglet** : un des trois nombres a bougé.
// 2. **Une fenêtre introuvable** : un écran débranché, et elle se rouvre à une position
//    qui n'existe plus, sans barre de titre où la saisir.
// 3. **Un fichier d'état abîmé** qui empêche d'ouvrir la fenêtre.
// 4. **Une exception dans un rappel** (envoi à une fenêtre qui se ferme, écriture dans un
//    shell mort, programme introuvable) qui tombe dans le processus principal et emporte
//    avec lui tous les shells et tous les agents.
// 5. **Un rendu qui plante** : fenêtre blanche, sans message ni issue.
//
//     node scripts/check-window.mjs
import { build } from "esbuild"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-window-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "w.ts"),
  `export * from "${from("src/shared/windowChrome")}"\nexport * from "${from("src/main/windowState")}"\n`
)
await build({ entryPoints: [path.join(dir, "w.ts")], outfile: path.join(dir, "w.cjs"), bundle: true, format: "cjs", platform: "node", logLevel: "silent" })
const mod = createRequire(import.meta.url)(path.join(dir, "w.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8")

// ---- la barre de titre et les boutons -------------------------------------------------
{
  const bar = read("src/renderer/panels/TitleBar.tsx")
  const index = read("src/main/index.ts")
  check("la barre fait 44 px (h-11), comme la constante", mod.TITLEBAR_HEIGHT === 44 && /zy-drag flex h-11 /.test(bar))
  check("**les boutons sont centrés dans la barre**", mod.TRAFFIC_LIGHTS.y + mod.TRAFFIC_LIGHT_SIZE / 2 === mod.TITLEBAR_HEIGHT / 2, JSON.stringify(mod.TRAFFIC_LIGHTS))
  check(
    "**la place gardée à gauche des onglets est celle des boutons, plus de l'air**",
    mod.TRAFFIC_LIGHTS_INSET === mod.TRAFFIC_LIGHTS.x + mod.TRAFFIC_LIGHTS_WIDTH + 18 && bar.includes(`pl-[${mod.TRAFFIC_LIGHTS_INSET}px]`),
    `${mod.TRAFFIC_LIGHTS_INSET}px attendus dans la barre`
  )
  check("**les onglets de projet viennent APRÈS la place des boutons, pas dessous**", mod.TRAFFIC_LIGHTS_INSET > mod.TRAFFIC_LIGHTS.x + mod.TRAFFIC_LIGHTS_WIDTH)
  check("et seulement sur macOS, hors plein écran", /isMac && !fullScreen \? "pl-\[/.test(bar))
  check("le processus principal place les boutons avec la constante", /trafficLightPosition: TRAFFIC_LIGHTS/.test(index) && /titleBarStyle: process\.platform === "darwin" \? "hidden"/.test(index))
  check("les boutons sont dits permis : réduire, agrandir, fermer, plein écran", ["minimizable", "maximizable", "closable", "fullscreenable"].every((k) => new RegExp(`${k}: true`).test(index)))
  check("ils reviennent en plein écran (la barre qui descend en a besoin)", /setWindowButtonVisibility\(true\)/.test(index))
  check("la barre se saisit : elle est une zone de glisser, ses contrôles non", /zy-drag/.test(bar) && (bar.match(/zy-nodrag/g) ?? []).length >= 5)
  check("la plus petite fenêtre garde la barre lisible", mod.MIN_WINDOW.width >= 900 && /minWidth: MIN_WINDOW\.width/.test(index))
}

// ---- retenir la fenêtre ---------------------------------------------------------------------
{
  const main = { workArea: { x: 0, y: 25, width: 1920, height: 1055 } }
  const left = { workArea: { x: -1440, y: 0, width: 1440, height: 875 } }
  const two = [main, left]

  const sain = mod.fit({ x: 100, y: 80, width: 1200, height: 800, maximized: false, fullScreen: false }, two)
  check("une position valide est gardée telle quelle", sain.x === 100 && sain.y === 80 && sain.width === 1200 && sain.height === 800)

  const sur2 = mod.fit({ x: -1300, y: 50, width: 1200, height: 700 }, two)
  check("**une fenêtre sur un second écran (coordonnées négatives) y reste**", sur2.x === -1300 && sur2.y === 50)

  const debranche = mod.fit({ x: -1300, y: 50, width: 1200, height: 700 }, [main])
  check("**écran débranché : la fenêtre revient sur l'écran qui reste**", debranche.x >= 0 && debranche.x + debranche.width <= 1920 && debranche.y >= 25, JSON.stringify(debranche))

  const loin = mod.fit({ x: 9000, y: 9000, width: 1000, height: 700 }, [main])
  check("une position absurde est ramenée, centrée", loin.x === Math.round((1920 - 1000) / 2) && loin.y === 25 + Math.round((1055 - 700) / 2), JSON.stringify(loin))

  const sansBarre = mod.fit({ x: 400, y: -500, width: 1000, height: 700 }, [main])
  check("**une barre de titre hors de l'écran (au-dessus) est ramenée : on ne pourrait plus la saisir**", sansBarre.y >= 25, JSON.stringify(sansBarre))

  const bord = mod.fit({ x: 1850, y: 100, width: 1000, height: 700 }, [main])
  check("une fenêtre dont seule une bande dépasse à droite reste saisissable", bord.x < 1920 - 100, JSON.stringify(bord))

  const grosse = mod.fit({ x: 0, y: 25, width: 5000, height: 4000 }, [main])
  check("**plus grande que l'écran : réduite à l'écran**", grosse.width <= 1920 && grosse.height <= 1055, JSON.stringify(grosse))

  const minuscule = mod.fit({ x: 0, y: 25, width: 100, height: 100 }, [main])
  check("plus petite que le minimum : relevée au minimum", minuscule.width >= mod.MIN_WINDOW.width && minuscule.height >= mod.MIN_WINDOW.height)

  const petitEcran = mod.fit({ x: 0, y: 0, width: 1440, height: 900 }, [{ workArea: { x: 0, y: 0, width: 800, height: 500 } }])
  check("un écran plus petit que le minimum ne produit pas une fenêtre plus grande que lui", petitEcran.width <= 800 && petitEcran.height <= 500, JSON.stringify(petitEcran))

  const neuf = mod.fit(null, [main])
  check("rien de retenu : la taille d'origine, centrée", neuf.width === 1440 && neuf.height === 900 && neuf.x === Math.round((1920 - 1440) / 2))

  const max = mod.fit({ x: 10, y: 40, width: 1100, height: 700, maximized: true, fullScreen: true }, [main])
  check("agrandie et plein écran sont retenus", max.maximized === true && max.fullScreen === true)

  const cascade = mod.fit({ x: 100, y: 80, width: 1200, height: 800 }, [main], 28)
  check("une fenêtre de plus s'ouvre en cascade", cascade.x === 128 && cascade.y === 108)

  const sansEcran = mod.fit({ x: 10, y: 10, width: 1000, height: 700 }, [])
  check("même sans la liste des écrans, une fenêtre sort (pas de plantage)", Number.isFinite(sansEcran.x) && sansEcran.width > 0)

  check("un état abîmé n'est rien", [null, undefined, "x", {}, { width: "a", height: 5 }, { width: -1, height: 5 }, { width: NaN, height: 4 }].every((v) => mod.parseState(v) === null))
  check("un état partiel garde ce qui est sain", mod.parseState({ width: 800, height: 600, x: "oops" }).x === undefined)
}

// ---- le disque ------------------------------------------------------------------------------
{
  const d = mkdtempSync(path.join(tmpdir(), "zyvro-win-"))
  try {
    const f = path.join(d, "sub", "window-state.json")
    check("pas de fichier : rien, sans lever", mod.load(f) === null)
    mod.save(f, { x: 1, y: 2, width: 1000, height: 700, maximized: false, fullScreen: false })
    check("écrit puis relu", mod.load(f)?.width === 1000 && mod.load(f)?.x === 1)
    writeFileSync(f, "{ coupé")
    check("**un fichier coupé n'empêche pas d'ouvrir une fenêtre**", mod.load(f) === null)
    writeFileSync(f, JSON.stringify({ width: "x" }))
    check("un fichier d'un autre format non plus", mod.load(f) === null)
    // Un « dossier » qui est un fichier : impossible d'y écrire, sur tous les systèmes.
    const fichier = path.join(d, "un-fichier")
    writeFileSync(fichier, "x")
    let leve = false
    try {
      mod.save(path.join(fichier, "sous", "window-state.json"), { x: 0, y: 0, width: 1000, height: 700, maximized: false, fullScreen: false })
    } catch {
      leve = true
    }
    check("**un disque qui refuse l'écriture ne lève pas**", !leve)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

// ---- ce qui empêche de tomber -------------------------------------------------------------------
{
  const index = read("src/main/index.ts")
  const term = read("src/main/terminal.ts")
  // Le lancement du pty (et son repli `script`) vit à part, partagé avec l'hôte de terminaux.
  const spawnSrc = read("src/main/ptySpawn.ts")
  check("**un envoi à une fenêtre qui se ferme ne lève plus** (webContents.send durci)", /function hardenSend/.test(index) && /proto\.send = function send/.test(index) && /hardenSend\(win\.webContents\)/.test(index))
  check("**une exception non rattrapée est notée, et l'app continue**", /process\.on\("uncaughtException"/.test(index))
  check("**mais pas à l'infini : une rafale arrête l'app franchement**", /storm\.length > 25/.test(index) && /app\.exit\(1\)/.test(index))
  check("**un rendu qui tombe est rechargé, trois fois par minute au plus**", /gone\.length <= 3/.test(index) && /win\.webContents\.reload\(\)/.test(index))
  check("au-delà, la fenêtre le dit au lieu de clignoter", /The window keeps crashing/.test(index))
  check("la fenêtre retenue est ramenée quand un écran part", /display-removed/.test(index) && /display-metrics-changed/.test(index) && /removeListener\("display-removed", reseat\)/.test(index))
  check("plein écran retenu : rétabli une fois la fenêtre montrée", /if \(placed\.fullScreen\) win\.setFullScreen\(true\)/.test(index))

  check("**écrire, redimensionner ou tuer un shell déjà mort ne lève pas**", /const quiet = \(what: string/.test(spawnSrc) && /write: \(d\) => quiet\("write"/.test(spawnSrc) && /resize: \(c, r\) => quiet\("resize"/.test(spawnSrc) && /kill: \(\) => quiet\("kill"/.test(spawnSrc))
  check("**un programme introuvable (événement `error`) ne tombe pas dans le processus principal**", /child\.on\("error"/.test(spawnSrc) && /end\(127\)/.test(spawnSrc))
  check("**le repli `script` cite ses arguments** (un prompt, un modèle, des espaces)", /\.map\(shellQuote\)\.join\(" "\)/.test(spawnSrc) && /function shellQuote/.test(spawnSrc))
  check("un tuyau fermé (EPIPE) non plus", /child\.stdin\?\.on\("error"/.test(spawnSrc))
  check("un caractère de plusieurs octets coupé entre deux morceaux est recomposé", /new StringDecoder\("utf8"\)/.test(spawnSrc))
  check("envoyer à la fenêtre ne lève jamais depuis un rappel de pty", /function sendSafe/.test(term) && !/target\.send\(/.test(term.replace(/function sendSafe[\s\S]*?\n}\n/, "")))
  check("la dernière sortie d'un shell part AVANT sa fin", /this\.sendPending\(id, target\)\s*const fini = this\.drop\(id\)/.test(term))
  check("un nettoyage qui lève n'empêche pas d'oublier le shell", /for \(const clean of \[session\.dispose, session\.cleanup\]\)/.test(term))
  check("rejouer un shell ne double pas ce qui attendait d'être envoyé", /session\.pending = ""[\s\S]{0,120}sendSafe\(target, "terminal:data", \{ id, data: session\.seen \}\)/.test(term))

  const main = read("src/renderer/main.tsx")
  const boundary = read("src/renderer/panels/ErrorBoundary.tsx")
  check("**une erreur de rendu ne laisse pas une fenêtre blanche**", /<ErrorBoundary>/.test(main) && /getDerivedStateFromError/.test(boundary) && /window\.location\.reload\(\)/.test(boundary))
  check("l'erreur est notée au journal du bouton bug", /reportIncident\("renderer:render-error"/.test(boundary))
}

console.log(failures === 0 ? "\nLa fenêtre se retrouve où on l'a laissée, et ne tombe pas pour une exception de rappel." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
