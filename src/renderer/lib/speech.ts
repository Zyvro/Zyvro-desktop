// Lire une réponse de l'agent à voix haute.
//
// La synthèse vocale du système, par l'API du navigateur (`speechSynthesis`) :
// rien à installer, rien qui sorte de la machine, les voix que macOS ou
// Windows ont déjà. Une seule lecture à la fois — c'est une seule voix, et
// deux réponses lues ensemble ne s'écoutent pas.
//
// Ce qu'on lit est ce qu'on entendrait lire quelqu'un : le texte, pas la
// syntaxe Markdown, et pas les blocs de code, qui ne se lisent pas à voix haute.

const ecouteurs = new Set<() => void>()
let enCours: string | null = null
// Le numéro de la lecture en cours : la fin d'une lecture annulée ne doit pas
// éteindre le bouton de la suivante.
let lecture = 0

function prevenir(): void {
  for (const listener of ecouteurs) listener()
}

export function subscribeSpeech(listener: () => void): () => void {
  ecouteurs.add(listener)
  return () => ecouteurs.delete(listener)
}

/** L'identifiant du message qu'on lit, ou null. */
export function speakingId(): string | null {
  return enCours
}

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined"
}

/** Le Markdown d'une réponse, rendu à ce qui se dit. */
export function speakableText(markdown: string): string {
  return (
    markdown
      // Les blocs de code : sautés, ils ne se lisent pas à voix haute.
      .replace(/```[\s\S]*?(```|$)/g, "\n")
      .replace(/~~~[\s\S]*?(~~~|$)/g, "\n")
      // Images, puis liens : leur texte seulement.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<https?:[^>]+>/g, "")
      // Le code en ligne garde son texte, sans les accents graves.
      .replace(/`([^`]*)`/g, "$1")
      // Titres, citations, puces, listes numérotées, séparateurs.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/^\s*([-*_]\s*){3,}$/gm, "")
      // Tableaux : les barres et les lignes de séparation.
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
      .replace(/\|/g, ", ")
      // Gras, italique, barré.
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim()
  )
}

const MOTS_FR = /\b(le|la|les|des|une|est|pas|pour|que|qui|dans|avec|sur|vous|nous|je|tu|il|elle|ce|cette|et|mais|ou|donc)\b/gi
const MOTS_EN = /\b(the|is|are|not|for|that|which|in|with|on|you|we|i|it|this|and|but|or|so|of|to)\b/gi

/** La langue d'une réponse, devinée sur ses petits mots — pour choisir la voix. */
export function guessLang(text: string): "fr-FR" | "en-US" {
  const fr = text.match(MOTS_FR)?.length ?? 0
  const en = text.match(MOTS_EN)?.length ?? 0
  return fr > en ? "fr-FR" : "en-US"
}

/**
 * Découpé en phrases d'au plus `max` caractères : Chromium coupe une lecture
 * trop longue au bout d'une quinzaine de secondes sur certains systèmes, et une
 * file de phrases s'arrête proprement entre deux.
 */
export function chunks(text: string, max = 220): string[] {
  const phrases = text.match(/[^.!?…\n]+[.!?…]*\s*|\n/g) ?? [text]
  const out: string[] = []
  let courant = ""
  for (const brute of phrases) {
    const phrase = brute.replace(/\s+/g, " ")
    if (phrase.trim() === "") continue
    if ((courant + phrase).length > max && courant.trim() !== "") {
      out.push(courant.trim())
      courant = ""
    }
    if (phrase.length > max) {
      // Une phrase sans fin : coupée aux espaces.
      for (const mot of phrase.split(" ")) {
        if ((courant + " " + mot).length > max && courant.trim() !== "") {
          out.push(courant.trim())
          courant = ""
        }
        courant += `${mot} `
      }
    } else {
      courant += phrase
    }
  }
  if (courant.trim() !== "") out.push(courant.trim())
  return out
}

function voixPour(lang: string): SpeechSynthesisVoice | null {
  const voix = window.speechSynthesis.getVoices()
  const prefixe = lang.slice(0, 2)
  return (
    voix.find((v) => v.lang === lang && v.localService) ??
    voix.find((v) => v.lang.startsWith(prefixe) && v.localService) ??
    voix.find((v) => v.lang.startsWith(prefixe)) ??
    null
  )
}

/** Lire ce message, ou l'arrêter s'il est déjà lu. */
export function toggleSpeech(id: string, markdown: string): void {
  if (enCours === id) {
    stopSpeaking()
    return
  }
  speak(id, markdown)
}

export function speak(id: string, markdown: string): void {
  if (!speechAvailable()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const texte = speakableText(markdown)
  const morceaux = chunks(texte)
  if (morceaux.length === 0) return
  const lang = guessLang(texte)
  const voix = voixPour(lang)
  const numero = ++lecture
  enCours = id
  prevenir()
  const finir = (): void => {
    if (numero !== lecture) return
    enCours = null
    prevenir()
  }
  morceaux.forEach((morceau, index) => {
    const u = new SpeechSynthesisUtterance(morceau)
    u.lang = lang
    if (voix) u.voice = voix
    if (index === morceaux.length - 1) u.onend = finir
    u.onerror = finir
    synth.speak(u)
  })
}

export function stopSpeaking(): void {
  lecture++
  if (speechAvailable()) window.speechSynthesis.cancel()
  if (enCours !== null) {
    enCours = null
    prevenir()
  }
}
