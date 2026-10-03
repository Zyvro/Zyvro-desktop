import { useMemo, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { Sparkle } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentKind } from "../../shared/harness"

// La couleur du chat d'agent.
//
// Demandé par Jeremy : « un peu comme dans codex ou claude code, c'est plus
// coloré ». Le panneau était gris de bout en bout — le nom du harnais, les
// outils, le code — et c'est la couleur qui permet de lire un long tour d'un
// coup d'œil : où il a écrit, où il a lancé une commande, où ça a échoué.
//
// Rien ici n'injecte de HTML. Le code est colorié avec les jetons du tokenizer
// de l'éditeur, rendus en <span> par React : le texte d'un modèle reste du
// texte, comme le promet le Markdown partagé.

// ---------- les harnais ----------

/** La teinte de chaque harnais : sa pastille et son nom au-dessus de ses réponses. */
export const HARNESS_TINT: Record<AgentKind, { dot: string; text: string }> = {
  // L'orange de Claude, le vert-bleu de Codex, le violet de Qwen, l'orange
  // Xiaomi de MiMo — reconnaissables sans lire le nom.
  claude: { dot: "bg-[#d97757]", text: "text-[#e8957a]" },
  codex: { dot: "bg-emerald-400", text: "text-emerald-300" },
  qwen: { dot: "bg-violet-400", text: "text-violet-300" },
  mimo: { dot: "bg-[#ff6900]", text: "text-[#ff8a3d]" },
}

// ---------- le code ----------

// Les noms de bloc les plus courants, vers les identifiants de Monaco. Le reste
// passe par l'extension (`ts`, `py`, `go`…), comme pour un fichier.
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  console: "shell",
  shell: "shell",
  "shell-session": "shell",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  golang: "go",
  "c++": "cpp",
  cs: "csharp",
  rb: "ruby",
  kt: "kotlin",
  ps1: "powershell",
  pwsh: "powershell",
  dockerfile: "dockerfile",
  jsonc: "json",
}

function monacoLanguage(fence: string): string {
  const name = fence.trim().toLowerCase()
  return ALIASES[name] ?? name
}

// La couleur d'un jeton, d'après son type (« keyword.ts », « string.quoted »…).
// Les mêmes teintes que le thème `zyvro-dark` de l'éditeur, pour qu'un extrait
// dans le chat ressemble au fichier qu'il cite.
function tokenClass(type: string): string {
  if (type.startsWith("comment")) return "text-[#6b6b7b] italic"
  if (type.startsWith("keyword") || type.startsWith("storage")) return "text-[#a78bfa]"
  if (type.startsWith("string") || type.startsWith("attribute.value")) return "text-[#5eead4]"
  if (type.startsWith("number") || type.startsWith("constant")) return "text-[#fbbf24]"
  if (type.startsWith("type") || type.startsWith("tag") || type.startsWith("metatag")) return "text-[#7dd3fc]"
  if (type.startsWith("attribute.name") || type.startsWith("key")) return "text-[#fdba74]"
  if (type.startsWith("regexp")) return "text-[#fb7185]"
  if (type.startsWith("variable") || type.startsWith("predefined")) return "text-[#f9a8d4]"
  if (type.startsWith("delimiter") || type.startsWith("operator")) return "text-[#9ca3af]"
  return ""
}

type Monaco = typeof import("monaco-editor")

// Monaco, et le tokenizer de ce langage, prêts. Chargés à la demande : les
// règles d'un langage arrivent en différé, et `colorize` est ce qui attend
// qu'elles soient là — son résultat HTML n'est pas utilisé.
function useTokenizer(language: string) {
  return useQuery({
    queryKey: ["chat-tokenizer", language],
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async (): Promise<Monaco | null> => {
      const { monaco } = await import("~/lib/monaco")
      if (!monaco.languages.getLanguages().some((l) => l.id === language)) return null
      await monaco.editor.colorize("", language, {})
      return monaco
    },
  })
}

function DiffLines({ code }: { code: string }) {
  return (
    <>
      {/* Une ligne par bloc, sur toute la largeur : une ligne trop longue qui
          revient à la ligne garde son fond, au lieu de passer pour une autre. */}
      {code.split("\n").map((line, index) => (
        <span key={index} className={cn("block", diffLineClass(line))}>
          {line || " "}
        </span>
      ))}
    </>
  )
}

/** La teinte d'une ligne de diff : ajout, retrait, en-tête de bloc. */
export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-foreground/60 font-semibold"
  if (line.startsWith("+")) return "text-emerald-300 bg-emerald-400/[0.08]"
  if (line.startsWith("-")) return "text-red-300 bg-red-400/[0.08]"
  if (line.startsWith("@@")) return "text-sky-300"
  return ""
}

function Tokens({ code, language }: { code: string; language: string }) {
  const ready = useTokenizer(language)
  const monaco = ready.data
  const lines = useMemo(() => (monaco ? monaco.editor.tokenize(code, language) : null), [monaco, code, language])
  // Le texte nu tant que le tokenizer arrive, ou pour un langage inconnu.
  if (!lines) return <>{code}</>
  const source = code.split("\n")
  return (
    <>
      {lines.map((tokens, row) => {
        const text = source[row] ?? ""
        return (
          <span key={row}>
            {tokens.map((token, index) => {
              const end = tokens[index + 1]?.offset ?? text.length
              const piece = text.slice(token.offset, end)
              const tint = tokenClass(token.type)
              return tint ? (
                <span key={index} className={tint}>
                  {piece}
                </span>
              ) : (
                piece
              )
            })}
            {row < source.length - 1 ? "\n" : ""}
          </span>
        )
      })}
    </>
  )
}

/** Ce que le Markdown du chat appelle pour dessiner un bloc de code. */
export function renderCode(code: string, fence: string): ReactNode {
  const language = monacoLanguage(fence)
  if (language === "diff" || language === "patch") return <DiffLines code={code} />
  if (!language) return code
  return <Tokens code={code} language={language} />
}

// ---------- les sorties d'outils ----------

/**
 * ToolOutput : ce qu'un outil a rendu, avec la couleur qui le rend lisible —
 * un diff se lit en vert et en rouge, comme dans un terminal.
 */
export function ToolOutput({ text, className }: { text: string; className?: string }) {
  return <pre className={className}>{looksLikeDiff(text) ? <DiffLines code={text} /> : text}</pre>
}

/** Un diff unifié, ou assez de lignes marquées + / - pour en être un. */
export function looksLikeDiff(text: string): boolean {
  if (/^@@ /m.test(text) || /^(\+\+\+|---) \S/m.test(text)) return true
  const lines = text.split("\n").filter((l) => l.trim() !== "")
  const marked = lines.filter((l) => /^[+-](?![+-]{2})/.test(l)).length
  return marked >= 2 && marked * 4 >= lines.length
}

// ---------- « il travaille » ----------

/**
 * Working : la fin d'un message tant que l'agent produit.
 *
 * « Thinking… » en gris fixe ne disait pas si quelque chose se passait encore.
 * Comme Claude Code, une étoile qui tourne, le verbe qui scintille, et trois
 * points qui sautent — et le verbe dit ce qu'il fait : il réfléchit avant le
 * premier mot, il lance un outil, il écrit.
 */
export function Working({ verb, kind }: { verb: string; kind: AgentKind }) {
  const tint = HARNESS_TINT[kind] ?? HARNESS_TINT.claude
  return (
    <div className="zy-working mt-1 flex items-center gap-1.5 text-[11px]" role="status" aria-live="polite">
      <Sparkle className={cn("h-3 w-3 shrink-0 zy-working-star", tint.text)} />
      <span className="zy-shimmer font-medium">{verb}</span>
      <span className={cn("zy-dots", tint.text)} aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </div>
  )
}
