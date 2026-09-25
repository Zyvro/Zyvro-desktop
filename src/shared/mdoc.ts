// Le Markdown d'un document, pour l'aperçu (⇧⌘V).
//
// Le rendu du chat est fait pour des réponses de modèle : titres à peine plus
// gros que le texte, pas d'images, pas de liens relatifs. Un README n'est pas
// une réponse de modèle. Celui-ci lit ce qu'on trouve dans un dépôt : titres
// ancrés (les ids de GitHub), listes imbriquées et cases à cocher, tableaux
// alignés, images et liens relatifs au fichier, liens par référence
// (`[texte][ref]`, ceux des badges), et le HTML le plus courant des README —
// `<img>` et `<br>` — sans jamais en injecter : il en produit un arbre de
// données, que le rendu transforme en éléments React.
//
// Pur, sans DOM : `scripts/check-mdoc.mjs` le vérifie.

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong" | "em" | "del"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  | { t: "image"; src: string; alt: string }
  | { t: "br" }

export type ListItem = { checked: boolean | null; blocks: Block[] }
export type Align = "left" | "center" | "right" | null

export type Block =
  | { t: "heading"; level: number; text: string; id: string }
  | { t: "para"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { t: "rule" }
  | { t: "html"; images: { src: string; alt: string }[]; text: string; center: boolean }

export type Doc = { blocks: Block[]; refs: Map<string, string> }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const HTML_BLOCK = /^ {0,3}<(?:\/?[a-zA-Z][\w-]*[\s/>]|\/?[a-zA-Z][\w-]*$|!--)/
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const REF_DEF = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/

const blank = (line: string): boolean => line.trim() === ""
const indentOf = (line: string): number => line.length - line.replace(/^[ \t]+/, "").length
const refKey = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase()

export function parseDoc(source: string): Doc {
  const refs = new Map<string, string>()
  const lines: string[] = []
  let inFence = false
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence
    const def = inFence ? null : REF_DEF.exec(line)
    if (def) {
      if (!refs.has(refKey(def[1]))) refs.set(refKey(def[1]), def[2])
      continue
    }
    lines.push(line.replace(/\t/g, "    "))
  }
  const ids = new Map<string, number>()
  return { blocks: parseBlocks(lines, ids), refs }
}

// Un bloc commence-t-il ici ? Ce qui interrompt un paragraphe.
function starts(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    HTML_BLOCK.test(line) ||
    (ITEM.test(line) && indentOf(line) < 4 && Boolean(ITEM.exec(line)?.[3]))
  )
}

function parseBlocks(lines: string[], ids: Map<string, number>): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const entered = i
    if (blank(line)) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marque = fence[1]
      const retrait = indentOf(line)
      const body: string[] = []
      i++
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i])
        if (close && close[1][0] === marque[0] && close[1].length >= marque.length) {
          i++
          break
        }
        body.push(lines[i].slice(Math.min(retrait, indentOf(lines[i]))))
        i++
      }
      out.push({ t: "code", lang: fence[2].toLowerCase(), text: body.join("\n") })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const text = (heading[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "")
      out.push({ t: "heading", level: heading[1].length, text, id: uniqueId(ids, slug(plainText(text))) })
      i++
      continue
    }

    if (RULE.test(line)) {
      out.push({ t: "rule" })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && !blank(lines[i])) {
        const q = QUOTE.exec(lines[i])
        // Une ligne sans `>` qui suit continue la citation (paresse de CommonMark).
        body.push(q ? q[1] : lines[i])
        i++
      }
      out.push({ t: "quote", blocks: parseBlocks(body, ids) })
      continue
    }

    const item = ITEM.exec(line)
    if (item && indentOf(line) < 4) {
      i = parseList(lines, i, ids, out)
      continue
    }

    if (HTML_BLOCK.test(line)) {
      const body: string[] = []
      while (i < lines.length && !blank(lines[i])) body.push(lines[i++])
      out.push(htmlBlock(body.join("\n")))
      continue
    }

    // Un tableau : une ligne à barres, puis la ligne des tirets.
    if (line.includes("|") && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c): Align => {
        const g = c.startsWith(":")
        const d = c.endsWith(":")
        return g && d ? "center" : d ? "right" : g ? "left" : null
      })
      i += 2
      const rows: string[][] = []
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) rows.push(cells(lines[i++]))
      out.push({ t: "table", align, head, rows })
      continue
    }

    // Un paragraphe, jusqu'à une ligne vide ou un autre bloc. Souligné de `===`
    // ou de `---`, c'est un titre.
    const para: string[] = [line.trim()]
    i++
    let setext = 0
    while (i < lines.length && !blank(lines[i])) {
      const s = SETEXT.exec(lines[i])
      if (s) {
        setext = s[1][0] === "=" ? 1 : 2
        i++
        break
      }
      if (starts(lines[i])) break
      para.push(lines[i].replace(/^[ \t]+/, ""))
      i++
    }
    if (setext) {
      const text = para.join(" ")
      out.push({ t: "heading", level: setext, text, id: uniqueId(ids, slug(plainText(text))) })
    } else {
      out.push({ t: "para", text: para.join("\n") })
    }
    // Chaque passage consomme au moins une ligne ; sinon, on boucle pour toujours.
    if (i === entered) i++
  }
  return out
}

function parseList(lines: string[], from: number, ids: Map<string, number>, out: Block[]): number {
  const first = ITEM.exec(lines[from]) as RegExpExecArray
  const ordered = /\d/.test(first[2])
  const base = first[1].length
  const items: ListItem[] = []
  let i = from
  while (i < lines.length) {
    const m = ITEM.exec(lines[i])
    if (!m || /\d/.test(m[2]) !== ordered || m[1].length < base || m[1].length > base + 3) break
    const contenu = m[1].length + m[2].length + 1
    const body: string[] = [m[3] ?? ""]
    i++
    while (i < lines.length) {
      const l = lines[i]
      if (blank(l)) {
        // Une ligne vide : l'élément continue si ce qui suit est en retrait.
        let j = i
        while (j < lines.length && blank(lines[j])) j++
        if (j < lines.length && indentOf(lines[j]) >= contenu) {
          for (; i < j; i++) body.push("")
          continue
        }
        break
      }
      if (indentOf(l) >= contenu) {
        body.push(l.slice(contenu))
        i++
        continue
      }
      // Même niveau ou plus haut : un autre élément, ou la fin de la liste.
      if (ITEM.test(l) && indentOf(l) < contenu) break
      if (starts(l)) break
      // Sinon, la suite paresseuse du texte de l'élément.
      body.push(l.trim())
      i++
    }
    let checked: boolean | null = null
    const task = /^\[([ xX])\][ \t]+/.exec(body[0])
    if (task) {
      checked = task[1] !== " "
      body[0] = body[0].slice(task[0].length)
    }
    items.push({ checked, blocks: parseBlocks(body, ids) })
    // Entre deux éléments, les lignes vides ne cassent pas la liste.
    let j = i
    while (j < lines.length && blank(lines[j])) j++
    const suite = j < lines.length ? ITEM.exec(lines[j]) : null
    if (suite && /\d/.test(suite[2]) === ordered && suite[1].length >= base && suite[1].length <= base + 3) i = j
    else break
  }
  out.push({ t: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items })
  return i
}

function cells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  const out: string[] = []
  let cur = ""
  let code = false
  for (let k = 0; k < s.length; k++) {
    const c = s[k]
    if (c === "\\" && s[k + 1] === "|") {
      cur += "|"
      k++
    } else if (c === "`") {
      code = !code
      cur += c
    } else if (c === "|" && !code) {
      out.push(cur.trim())
      cur = ""
    } else cur += c
  }
  out.push(cur.trim())
  return out
}

// Le HTML d'un README : on n'en garde que les images (le logo centré en tête)
// et le texte, sans balise.
function htmlBlock(html: string): Block {
  const images: { src: string; alt: string }[] = []
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = attr(tag, "src")
    if (src) images.push({ src, alt: attr(tag, "alt") ?? "" })
  }
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
  // `<p align="center">`, `<div align="center">` : le logo centré des README.
  return { t: "html", images, text, center: /^\s*<\w+[^>]*\balign\s*=\s*["']?center/i.test(html) }
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©" }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all
    }
    return ENTITIES[e.toLowerCase()] ?? all
  })
}

// ---- les ancres -------------------------------------------------------------

// slug : l'id que GitHub donne à un titre — minuscules, ponctuation retirée,
// espaces en tirets. C'est ce que visent les `[voir](#installation)` d'un README.
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-")
}

function uniqueId(ids: Map<string, number>, base: string): string {
  const n = ids.get(base) ?? 0
  ids.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}

// plainText : le texte d'un titre sans sa mise en forme, pour son ancre.
export function plainText(text: string): string {
  const walk = (xs: Inline[]): string =>
    xs
      .map((x) =>
        x.t === "text" || x.t === "code" ? x.text : x.t === "image" ? x.alt : x.t === "br" ? " " : walk(x.children)
      )
      .join("")
  return walk(parseInline(text, new Map()))
}

// ---- le texte dans les blocs ----------------------------------------------------

const ESCAPABLE = /[!-/:-@[-`{-~]/

export function parseInline(text: string, refs: Map<string, string>): Inline[] {
  const out: Inline[] = []
  let buf = ""
  const flush = (): void => {
    if (buf) out.push({ t: "text", text: buf })
    buf = ""
  }
  const push = (x: Inline): void => {
    flush()
    out.push(x)
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const rest = text.slice(i)

    if (c === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") {
        push({ t: "br" })
        i += 2
        continue
      }
      if (ESCAPABLE.test(text[i + 1])) {
        buf += text[i + 1]
        i += 2
        continue
      }
    }

    if (c === "\n") {
      // Deux espaces en fin de ligne : un saut de ligne. Sinon, un espace.
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, "")
        push({ t: "br" })
      } else buf += " "
      i++
      continue
    }

    if (c === "`") {
      const run = /^`+/.exec(rest)![0]
      const end = text.indexOf(run, i + run.length)
      // Une suite de ` qui ne se ferme pas est du texte.
      if (end > 0 && text[end + run.length] !== "`") {
        let code = text.slice(i + run.length, end).replace(/\n/g, " ")
        if (/^ .* $/.test(code)) code = code.slice(1, -1)
        push({ t: "code", text: code })
        i = end + run.length
        continue
      }
      buf += run
      i += run.length
      continue
    }

    if (c === "!" || c === "[") {
      const lien = linkAt(text, c === "!" ? i + 1 : i, refs)
      if (lien) {
        if (c === "!") push({ t: "image", src: lien.href, alt: plainOf(lien.label, refs) })
        else push({ t: "link", href: lien.href, children: parseInline(lien.label, refs) })
        i = lien.end
        continue
      }
    }

    if (c === "<") {
      const auto = /^<((?:https?|mailto):[^\s<>]+)>/i.exec(rest)
      if (auto) {
        push({ t: "link", href: auto[1], children: [{ t: "text", text: auto[1].replace(/^mailto:/i, "") }] })
        i += auto[0].length
        continue
      }
      const br = /^<br\s*\/?>/i.exec(rest)
      if (br) {
        push({ t: "br" })
        i += br[0].length
        continue
      }
      const img = /^<img\b[^>]*>/i.exec(rest)
      if (img) {
        const src = attr(img[0], "src")
        if (src) push({ t: "image", src, alt: attr(img[0], "alt") ?? "" })
        i += img[0].length
        continue
      }
      // Toute autre balise en ligne disparaît ; son texte reste.
      const tag = /^<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/.exec(rest)
      if (tag) {
        i += tag[0].length
        continue
      }
    }

    if ((c === "h" || c === "w") && /[^\p{L}\p{N}]$|^$/u.test(buf.slice(-1))) {
      const url = /^(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/i.exec(rest)
      if (url) {
        const href = url[0].startsWith("www.") ? `https://${url[0]}` : url[0]
        push({ t: "link", href, children: [{ t: "text", text: url[0] }] })
        i += url[0].length
        continue
      }
    }

    if (c === "~" && rest.startsWith("~~")) {
      const end = text.indexOf("~~", i + 2)
      if (end > i + 2) {
        push({ t: "del", children: parseInline(text.slice(i + 2, end), refs) })
        i = end + 2
        continue
      }
    }

    if (c === "*" || c === "_") {
      const double = rest.startsWith(c + c)
      const marque = double ? c + c : c
      // `_` au milieu d'un mot (snake_case) n'est pas de l'emphase.
      const avant = buf.slice(-1)
      const ouvrant =
        !/\s/.test(text[i + marque.length] ?? " ") && (c === "*" || !/[\p{L}\p{N}]/u.test(avant))
      if (ouvrant) {
        const end = closing(text, i + marque.length, marque)
        if (end > 0) {
          push({ t: double ? "strong" : "em", children: parseInline(text.slice(i + marque.length, end), refs) })
          i = end + marque.length
          continue
        }
      }
    }

    buf += c
    i++
  }
  flush()
  return out
}

// closing : où se ferme l'emphase ouverte par `marque` — pas précédée d'un
// espace, et pour `_`, pas suivie d'une lettre.
function closing(text: string, from: number, marque: string): number {
  let k = from
  while (k < text.length) {
    const at = text.indexOf(marque, k)
    if (at < 0) return -1
    // `**` ne ferme pas un `*` : on saute les doubles quand on cherche un simple.
    if (marque.length === 1 && text[at + 1] === marque) {
      k = at + 2
      continue
    }
    const ok =
      at > from && !/\s/.test(text[at - 1]) && (marque[0] === "*" || !/[\p{L}\p{N}]/u.test(text[at + marque.length] ?? ""))
    if (ok) return at
    k = at + 1
  }
  return -1
}

// linkAt : `[libellé](cible)`, `[libellé][ref]`, `[ref][]` ou `[ref]` à la
// position `i` (le `[`).
function linkAt(text: string, i: number, refs: Map<string, string>): { label: string; href: string; end: number } | null {
  if (text[i] !== "[") return null
  let depth = 0
  let k = i
  for (; k < text.length; k++) {
    if (text[k] === "\\") {
      k++
      continue
    }
    if (text[k] === "[") depth++
    else if (text[k] === "]" && --depth === 0) break
  }
  if (k >= text.length) return null
  const label = text.slice(i + 1, k)
  const apres = text.slice(k + 1)
  const direct = /^\(\s*<?([^\s<>()]*(?:\([^\s()]*\)[^\s<>()]*)*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(apres)
  if (direct) return { label, href: direct[1], end: k + 1 + direct[0].length }
  const ref = /^\[([^\]]*)\]/.exec(apres)
  if (ref) {
    const cle = refKey(ref[1] || label)
    const href = refs.get(cle)
    if (href !== undefined) return { label, href, end: k + 1 + ref[0].length }
    return null
  }
  const seul = refs.get(refKey(label))
  if (seul !== undefined) return { label, href: seul, end: k + 1 }
  return null
}

function plainOf(label: string, refs: Map<string, string>): string {
  const walk = (xs: Inline[]): string =>
    xs.map((x) => (x.t === "text" || x.t === "code" ? x.text : x.t === "image" ? x.alt : x.t === "br" ? " " : walk(x.children))).join("")
  return walk(parseInline(label, refs))
}

// ---- où mène un lien ------------------------------------------------------------

export type Target =
  | { kind: "web"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; path: string; anchor: string | null }
  | { kind: "data"; url: string }
  | null

// resolveTarget : ce que vise `href` depuis le document `doc` (un chemin du
// projet, ou absolu pour un fichier hors du projet). Relatif au dossier du
// document ; `/` en tête part de la racine du projet. Un chemin qui sortirait
// du projet n'y mène pas.
export function resolveTarget(doc: string, href: string): Target {
  const h = href.trim()
  if (h === "") return null
  if (/^https?:\/\//i.test(h)) return { kind: "web", url: h }
  if (/^data:image\/(png|gif|jpe?g|webp|svg\+xml);/i.test(h)) return { kind: "data", url: h }
  if (/^mailto:/i.test(h)) return { kind: "web", url: h }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^[a-z]:[\\/]/i.test(h)) return null
  if (h.startsWith("#")) return { kind: "anchor", id: safeDecode(h.slice(1)) }
  const [sansAncre, ancre] = splitOnce(h.replace(/\?[^#]*/, ""), "#")
  const chemin = safeDecode(sansAncre).replace(/\\/g, "/")
  const absoluDoc = doc.startsWith("/") || /^[a-z]:\//i.test(doc)
  let parts: string[]
  if (chemin.startsWith("/")) {
    if (absoluDoc) return null
    parts = chemin.split("/")
  } else {
    parts = [...doc.split("/").slice(0, -1), ...chemin.split("/")]
  }
  const out: string[] = []
  for (const p of parts) {
    if (p === "" || p === ".") continue
    if (p === "..") {
      if (out.length === 0 || (absoluDoc && out.length === 1 && /^[a-z]:$/i.test(out[0]))) return null
      out.pop()
      continue
    }
    out.push(p)
  }
  if (out.length === 0) return null
  const path = (doc.startsWith("/") ? "/" : "") + out.join("/")
  return { kind: "file", path, anchor: ancre ? safeDecode(ancre) : null }
}

function splitOnce(s: string, sep: string): [string, string | null] {
  const k = s.indexOf(sep)
  return k < 0 ? [s, null] : [s.slice(0, k), s.slice(k + 1)]
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
