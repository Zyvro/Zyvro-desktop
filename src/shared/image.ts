// Ce qui fait qu'une suite d'octets est une image.
//
// Une seule liste, parce qu'il y a maintenant quatre endroits qui posent la
// question et qu'ils doivent y répondre pareil : une pièce jointe qu'on garde,
// un fichier du projet qu'on ouvre, la vignette d'une puce, et le résultat d'un
// outil. La version où chacun regardait l'extension du nom est celle où un
// `.png` qui n'en est pas s'affiche cassé et où une capture sans extension ne
// s'affiche pas du tout.
//
// Lu dans les premiers octets, donc, et jamais dans le nom : un rendu qui
// enverrait `gentil.png` contenant autre chose obtiendrait sinon un fichier
// écrit sous un nom qui invite à l'ouvrir.

export type ImageKind = { extension: string; mime: string }

const SIGNATURES: { extension: string; mime: string; magic: number[][] }[] = [
  { extension: "png", mime: "image/png", magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  { extension: "jpg", mime: "image/jpeg", magic: [[0xff, 0xd8, 0xff]] },
  { extension: "gif", mime: "image/gif", magic: [[0x47, 0x49, 0x46, 0x38]] },
  // WEBP est RIFF....WEBP : ce sont les quatre octets à l'offset 8 qui le
  // distinguent d'un fichier wav, donc la vérification doit regarder au-delà de
  // l'en-tête et pas dedans.
  { extension: "webp", mime: "image/webp", magic: [[0x52, 0x49, 0x46, 0x46]] },
]

// Les extensions qu'on écrit sur le disque, dans l'ordre. Sert à retrouver un
// fichier dont on ne connaît que l'identifiant : le nom est le nôtre, mais son
// suffixe dépend de ce que les octets disaient au moment où on l'a écrit.
export const IMAGE_EXTENSIONS = SIGNATURES.map((s) => s.extension)

export function kindOf(bytes: Uint8Array): ImageKind | null {
  for (const candidate of SIGNATURES) {
    for (const magic of candidate.magic) {
      if (magic.every((byte, index) => bytes[index] === byte)) {
        if (candidate.extension !== "webp") return { extension: candidate.extension, mime: candidate.mime }
        const tail = [0x57, 0x45, 0x42, 0x50]
        if (tail.every((byte, index) => bytes[8 + index] === byte)) {
          return { extension: candidate.extension, mime: candidate.mime }
        }
      }
    }
  }
  return null
}

// Ce qu'une balise `<img>` peut prendre directement.
//
// Une adresse `data:` plutôt qu'un chemin, et c'est délibéré : le rendu n'a
// jamais appris où vivent les fichiers, et ce n'est pas pour lui donner
// l'adresse maintenant qu'on veut lui montrer une vignette. La politique de
// sécurité de la fenêtre autorise `data:` pour les images, ce qui suffit.
export function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}

// Au-delà de quoi on ne fabrique pas une adresse `data:`.
//
// Une image traverse l'IPC encodée en base64, donc elle grossit d'un tiers, et
// une capture d'un écran 6K fait déjà quelques mégaoctets. La borne existe pour
// qu'un fichier de trois cents mégaoctets ne devienne pas quatre cents
// mégaoctets de chaîne de caractères entre deux processus.
export const MAX_INLINE_BYTES = 12 * 1024 * 1024
