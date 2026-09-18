// Une image doit se voir.
//
// Trois endroits disaient le contraire, et c'est le même défaut à chaque fois :
// on a des octets d'image et on affiche du texte.
//
//   1. Une image déposée dans le chat n'y apparaissait pas. Les puces
//      montraient une icône et un nom, puis disparaissaient à l'envoi, et le
//      transcript ne gardait qu'un nom précédé d'un trombone.
//   2. Une image renvoyée par un outil était jetée en silence : un bloc
//      `{type:"image"}` n'a pas de champ `text`, et l'aplatissement du résultat
//      le réduisait à une chaîne vide.
//   3. Cliquer sur un `.png` dans l'arbre donnait « This file is binary or too
//      large to edit here » — vrai, et inutile : on ne voulait pas l'éditer.
//
// Ce qui casse en silence ici :
//
// **La question « est-ce une image ? » doit avoir une seule réponse.** Quatre
// endroits la posent. La version où chacun regarde l'extension du nom est celle
// où un `.png` qui n'en est pas s'affiche cassé, et où une capture sans
// extension ne s'affiche pas du tout.
//
// **Et le rendu ne doit jamais apprendre un chemin.** C'est la règle depuis les
// pièces jointes — un rendu qui nomme un chemin peut demander `/etc/passwd` en
// l'appelant une image — et une vignette ne l'entame pas : ce qui traverse est
// une adresse `data:`, jamais un chemin.
//
//     node scripts/check-images.mjs
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-image-check")
mkdirSync(dir, { recursive: true })
const from = (rel) => path.join(ROOT, rel).replace(/\\/g, "/")
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${from("src/shared/image")}"\n` + `export { imagesIn, outputIn } from "${from("src/main/tooltalk")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])
const TEXTE = new Uint8Array([...Buffer.from("bonjour, je suis du texte")])

// ---- une seule réponse à « est-ce une image ? » --------------------------
{
  check("**un PNG en est une**", mod.kindOf(PNG)?.mime === "image/png")
  check("un JPEG aussi", mod.kindOf(JPG)?.mime === "image/jpeg")
  check("un WebP aussi", mod.kindOf(WEBP)?.mime === "image/webp")
  // RIFF est aussi l'en-tête d'un wav : ce sont les quatre octets à l'offset 8
  // qui décident, et les lire à l'offset 0 rendrait tout wav « image ».
  check("**mais un wav n'en est pas une, malgré son RIFF**", mod.kindOf(WAV) === null)
  check("ni du texte", mod.kindOf(TEXTE) === null)

  // Une seule table. Deux, c'est celle qui ignore le format ajouté dans l'autre.
  const attach = readFileSync(path.join(ROOT, "src/main/attachments.ts"), "utf8")
  const files = readFileSync(path.join(ROOT, "src/main/files.ts"), "utf8")
  check(
    "**les pièces jointes n'ont pas leur propre table de signatures**",
    !/0x89, 0x50, 0x4e/.test(attach) && attach.includes('from "../shared/image"'),
    "attachments.ts reconnaît les images dans son coin"
  )
  check(
    "**et l'ouverture d'un fichier non plus**",
    !/0x89, 0x50, 0x4e/.test(files) && files.includes('from "../shared/image"'),
    "files.ts reconnaît les images dans son coin"
  )
  // L'extension du nom ne décide de rien : une capture sans extension est une
  // image, `notes.png` qui contient du texte n'en est pas.
  check(
    "et personne ne décide sur l'extension du nom",
    !/\.endsWith\("\.png"\)|\/\\.\(png\|jpe\?g\)/.test(files),
    "files.ts regarde le nom plutôt que les octets"
  )
}

// ---- ce qui traverse est une adresse, pas un chemin ----------------------
{
  const uri = mod.dataUri("image/png", PNG)
  check("**une image traverse en adresse `data:`**", uri.startsWith("data:image/png;base64,"), uri.slice(0, 40))
  check("et se relit", Buffer.from(uri.split(",")[1], "base64")[0] === 0x89)

  const attach = readFileSync(path.join(ROOT, "src/main/attachments.ts"), "utf8")
  const thumb = attach.slice(attach.indexOf("export async function thumbnail"))
  check(
    "**la vignette ne rend jamais un chemin**",
    thumb.includes("dataUri(") && !/return file\b/.test(thumb.slice(0, 900)),
    "thumbnail rend autre chose qu'une adresse data:"
  )
  const preload = readFileSync(path.join(ROOT, "src/preload/index.ts"), "utf8")
  check(
    "et le pont la demande par identifiant",
    /thumbnail: \(conversationId: string, id: string\)/.test(preload),
    "le pont demande une vignette autrement que par identifiant"
  )
}

// ---- une image renvoyée par un outil n'est plus jetée ---------------------
{
  const b64 = Buffer.from(PNG).toString("base64")

  // Le bloc Anthropic : les octets sous `source.data`.
  const anthropic = [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }]
  check("**le bloc image d'Anthropic est gardé**", mod.imagesIn(anthropic).length === 1)

  // Le bloc MCP : à plat sous `data`. Les outils de cette application parlent
  // MCP, et n'en lire qu'une des deux formes perd les images d'une moitié des
  // outils sans le dire.
  const mcp = [{ type: "image", data: b64, mimeType: "image/png" }]
  check("**et celui de MCP aussi**", mod.imagesIn(mcp).length === 1)
  check("les octets arrivent entiers", mod.imagesIn(mcp)[0].bytes[0] === 0x89)

  const mixte = [{ type: "text", text: "voici" }, ...anthropic]
  check("le texte et l'image cohabitent", mod.outputIn(mixte) === "voici" && mod.imagesIn(mixte).length === 1)
  check("un résultat sans image n'en invente pas", mod.imagesIn([{ type: "text", text: "rien" }]).length === 0)
  check("ni une chaîne toute seule", mod.imagesIn("du texte").length === 0)
  // Une donnée illisible ne doit pas emporter le reste du résultat.
  check(
    "et une donnée qu'on ne sait pas décoder ne casse rien",
    mod.imagesIn([{ type: "image", data: "" }, ...mcp]).length === 1
  )
}

// ---- et elle est rangée, pas recopiée dans le transcript ------------------
{
  const agent = readFileSync(path.join(ROOT, "src/main/agent.ts"), "utf8")
  check(
    "**une image d'outil est écrite à côté de la conversation**",
    agent.includes("keepImage("),
    "les octets d'une image d'outil ne sont rangés nulle part"
  )
  const conversations = readFileSync(path.join(ROOT, "src/main/conversations.ts"), "utf8")
  // Quatre mégaoctets de base64 réécrits à chaque sauvegarde du transcript ne
  // seraient pas une sauvegarde.
  check(
    "**et le transcript n'en garde que l'identifiant**",
    /images\?: \{ id: string; name: string \}\[\]/.test(conversations),
    "le transcript porte autre chose que des identifiants d'image"
  )
  const panel = readFileSync(path.join(ROOT, "src/renderer/panels/AgentPanel.tsx"), "utf8")
  check(
    "**et un message qui n'a qu'une image survit à l'écriture**",
    panel.includes("(m.images?.length ?? 0) > 0"),
    "un message sans texte est jeté à la sauvegarde, image comprise"
  )
}

// ---- cliquer sur une image la montre --------------------------------------
{
  const editor = readFileSync(path.join(ROOT, "src/renderer/panels/CodeEditor.tsx"), "utf8")
  check(
    "**un fichier image s'affiche au lieu de se déclarer illisible**",
    editor.includes('"image" in file.data') && editor.includes("<img"),
    "l'éditeur ne sait toujours qu'annoncer un binaire"
  )
  check(
    "sans recadrer ce qu'on voulait voir",
    editor.includes("object-contain"),
    "l'image est recadrée pour remplir le cadre"
  )
  check(
    "et sur un damier, qui dit ce qui est transparent",
    editor.includes("zy-checker") && readFileSync(path.join(ROOT, "src/renderer/styles.css"), "utf8").includes(".zy-checker"),
    "un logo blanc sur fond blanc aura l'air vide"
  )
}

console.log(
  failures === 0
    ? "\nCe qui est une image se voit : déposée, renvoyée par un outil, ou ouverte depuis l'arbre."
    : `\n${failures} échec(s)`
)
process.exit(failures === 0 ? 0 : 1)
