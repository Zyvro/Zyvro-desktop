// Les thèmes du chat d'agent, et les styles de l'indicateur « il travaille ».
//
// Demandé par Jeremy : choisir le thème du chat dans les réglages, choisir
// l'icône qui tourne pendant que l'agent écrit — et pouvoir téléverser la
// sienne. Un thème est une palette de variables CSS ; le chat ne connaît que
// les variables (`var(--zy-tool-read)`, `var(--zy-syn-keyword)`…), jamais les
// couleurs. Changer de thème, c'est réécrire ces variables, rien d'autre.
//
// Pur, pour `scripts/check-chat-themes.mjs` : la liste, les palettes, et ce
// qu'on accepte de relire d'un fichier de réglages.

export type ChatThemeId = "zyvro" | "claude" | "codex" | "ocean" | "dracula" | "mono"

export type ChatTheme = { id: ChatThemeId; label: string; hint: string; vars: Record<string, string> }

// Les variables qu'un thème doit toutes donner. Une palette qui en oublie une
// laisserait la couleur du thème précédent : un mélange qu'on n'a pas choisi.
export const CHAT_VARS = [
  "--zy-chat-user",
  "--zy-chat-code",
  "--zy-chat-code-bg",
  "--zy-chat-heading",
  "--zy-chat-heading-minor",
  "--zy-chat-strong",
  "--zy-chat-bullet",
  "--zy-chat-quote",
  "--zy-tool-read",
  "--zy-tool-edit",
  "--zy-tool-terminal",
  "--zy-tool-search",
  "--zy-tool-web",
  "--zy-tool-plan",
  "--zy-tool-agent",
  "--zy-syn-keyword",
  "--zy-syn-string",
  "--zy-syn-number",
  "--zy-syn-comment",
  "--zy-syn-type",
  "--zy-syn-attr",
  "--zy-syn-regexp",
  "--zy-syn-variable",
  "--zy-syn-delim",
  "--zy-diff-add",
  "--zy-diff-add-bg",
  "--zy-diff-del",
  "--zy-diff-del-bg",
  "--zy-diff-hunk",
  "--zy-working",
] as const

function palette(v: Record<(typeof CHAT_VARS)[number], string>): Record<string, string> {
  return v
}

export const CHAT_THEMES: ChatTheme[] = [
  {
    id: "zyvro",
    label: "Zyvro",
    hint: "Violet accents, a colour per kind of tool.",
    vars: palette({
      "--zy-chat-user": "#818cf8",
      "--zy-chat-code": "#f0abfc",
      "--zy-chat-code-bg": "rgba(217, 70, 239, 0.12)",
      "--zy-chat-heading": "#c4b5fd",
      "--zy-chat-heading-minor": "#a5b4fc",
      "--zy-chat-strong": "#fde68a",
      "--zy-chat-bullet": "#a78bfa",
      "--zy-chat-quote": "rgba(167, 139, 250, 0.5)",
      "--zy-tool-read": "#7dd3fc",
      "--zy-tool-edit": "#fcd34d",
      "--zy-tool-terminal": "#6ee7b7",
      "--zy-tool-search": "#c4b5fd",
      "--zy-tool-web": "#67e8f9",
      "--zy-tool-plan": "#f9a8d4",
      "--zy-tool-agent": "#a5b4fc",
      "--zy-syn-keyword": "#a78bfa",
      "--zy-syn-string": "#5eead4",
      "--zy-syn-number": "#fbbf24",
      "--zy-syn-comment": "#6b6b7b",
      "--zy-syn-type": "#7dd3fc",
      "--zy-syn-attr": "#fdba74",
      "--zy-syn-regexp": "#fb7185",
      "--zy-syn-variable": "#f9a8d4",
      "--zy-syn-delim": "#9ca3af",
      "--zy-diff-add": "#6ee7b7",
      "--zy-diff-add-bg": "rgba(52, 211, 153, 0.08)",
      "--zy-diff-del": "#fca5a5",
      "--zy-diff-del-bg": "rgba(248, 113, 113, 0.08)",
      "--zy-diff-hunk": "#7dd3fc",
      "--zy-working": "#c4b5fd",
    }),
  },
  {
    id: "claude",
    label: "Claude",
    hint: "Warm terracotta and sand, like Claude Code.",
    vars: palette({
      "--zy-chat-user": "#d97757",
      "--zy-chat-code": "#f4b183",
      "--zy-chat-code-bg": "rgba(217, 119, 87, 0.14)",
      "--zy-chat-heading": "#f0a07c",
      "--zy-chat-heading-minor": "#e8c39e",
      "--zy-chat-strong": "#ffd9b8",
      "--zy-chat-bullet": "#d97757",
      "--zy-chat-quote": "rgba(217, 119, 87, 0.55)",
      "--zy-tool-read": "#e8c39e",
      "--zy-tool-edit": "#f0a07c",
      "--zy-tool-terminal": "#a8c686",
      "--zy-tool-search": "#d4a5c9",
      "--zy-tool-web": "#9cc5c0",
      "--zy-tool-plan": "#e6b980",
      "--zy-tool-agent": "#c9a27e",
      "--zy-syn-keyword": "#e07a5f",
      "--zy-syn-string": "#a8c686",
      "--zy-syn-number": "#f2cc8f",
      "--zy-syn-comment": "#8a7a6c",
      "--zy-syn-type": "#e8c39e",
      "--zy-syn-attr": "#f4b183",
      "--zy-syn-regexp": "#e76f51",
      "--zy-syn-variable": "#d4a5c9",
      "--zy-syn-delim": "#a89888",
      "--zy-diff-add": "#a8c686",
      "--zy-diff-add-bg": "rgba(168, 198, 134, 0.1)",
      "--zy-diff-del": "#e76f51",
      "--zy-diff-del-bg": "rgba(231, 111, 81, 0.1)",
      "--zy-diff-hunk": "#e8c39e",
      "--zy-working": "#f0a07c",
    }),
  },
  {
    id: "codex",
    label: "Codex",
    hint: "Terminal green on black, quiet everywhere else.",
    vars: palette({
      "--zy-chat-user": "#34d399",
      "--zy-chat-code": "#86efac",
      "--zy-chat-code-bg": "rgba(52, 211, 153, 0.1)",
      "--zy-chat-heading": "#6ee7b7",
      "--zy-chat-heading-minor": "#a7f3d0",
      "--zy-chat-strong": "#d1fae5",
      "--zy-chat-bullet": "#34d399",
      "--zy-chat-quote": "rgba(52, 211, 153, 0.45)",
      "--zy-tool-read": "#a7f3d0",
      "--zy-tool-edit": "#fde68a",
      "--zy-tool-terminal": "#4ade80",
      "--zy-tool-search": "#99f6e4",
      "--zy-tool-web": "#5eead4",
      "--zy-tool-plan": "#bef264",
      "--zy-tool-agent": "#86efac",
      "--zy-syn-keyword": "#4ade80",
      "--zy-syn-string": "#fde68a",
      "--zy-syn-number": "#bef264",
      "--zy-syn-comment": "#4b6355",
      "--zy-syn-type": "#5eead4",
      "--zy-syn-attr": "#a7f3d0",
      "--zy-syn-regexp": "#fca5a5",
      "--zy-syn-variable": "#d1fae5",
      "--zy-syn-delim": "#6b8a78",
      "--zy-diff-add": "#4ade80",
      "--zy-diff-add-bg": "rgba(74, 222, 128, 0.09)",
      "--zy-diff-del": "#f87171",
      "--zy-diff-del-bg": "rgba(248, 113, 113, 0.09)",
      "--zy-diff-hunk": "#5eead4",
      "--zy-working": "#4ade80",
    }),
  },
  {
    id: "ocean",
    label: "Ocean",
    hint: "Cool blues and teals.",
    vars: palette({
      "--zy-chat-user": "#38bdf8",
      "--zy-chat-code": "#7dd3fc",
      "--zy-chat-code-bg": "rgba(56, 189, 248, 0.12)",
      "--zy-chat-heading": "#7dd3fc",
      "--zy-chat-heading-minor": "#93c5fd",
      "--zy-chat-strong": "#bae6fd",
      "--zy-chat-bullet": "#38bdf8",
      "--zy-chat-quote": "rgba(56, 189, 248, 0.5)",
      "--zy-tool-read": "#93c5fd",
      "--zy-tool-edit": "#fcd34d",
      "--zy-tool-terminal": "#5eead4",
      "--zy-tool-search": "#a5b4fc",
      "--zy-tool-web": "#67e8f9",
      "--zy-tool-plan": "#c4b5fd",
      "--zy-tool-agent": "#7dd3fc",
      "--zy-syn-keyword": "#60a5fa",
      "--zy-syn-string": "#5eead4",
      "--zy-syn-number": "#fcd34d",
      "--zy-syn-comment": "#64748b",
      "--zy-syn-type": "#67e8f9",
      "--zy-syn-attr": "#a5b4fc",
      "--zy-syn-regexp": "#f9a8d4",
      "--zy-syn-variable": "#bae6fd",
      "--zy-syn-delim": "#94a3b8",
      "--zy-diff-add": "#5eead4",
      "--zy-diff-add-bg": "rgba(94, 234, 212, 0.08)",
      "--zy-diff-del": "#fda4af",
      "--zy-diff-del-bg": "rgba(253, 164, 175, 0.08)",
      "--zy-diff-hunk": "#93c5fd",
      "--zy-working": "#7dd3fc",
    }),
  },
  {
    id: "dracula",
    label: "Dracula",
    hint: "The classic: purple, pink, green, cyan.",
    vars: palette({
      "--zy-chat-user": "#bd93f9",
      "--zy-chat-code": "#ff79c6",
      "--zy-chat-code-bg": "rgba(255, 121, 198, 0.12)",
      "--zy-chat-heading": "#bd93f9",
      "--zy-chat-heading-minor": "#8be9fd",
      "--zy-chat-strong": "#f1fa8c",
      "--zy-chat-bullet": "#ff79c6",
      "--zy-chat-quote": "rgba(189, 147, 249, 0.55)",
      "--zy-tool-read": "#8be9fd",
      "--zy-tool-edit": "#ffb86c",
      "--zy-tool-terminal": "#50fa7b",
      "--zy-tool-search": "#bd93f9",
      "--zy-tool-web": "#8be9fd",
      "--zy-tool-plan": "#ff79c6",
      "--zy-tool-agent": "#bd93f9",
      "--zy-syn-keyword": "#ff79c6",
      "--zy-syn-string": "#f1fa8c",
      "--zy-syn-number": "#bd93f9",
      "--zy-syn-comment": "#6272a4",
      "--zy-syn-type": "#8be9fd",
      "--zy-syn-attr": "#50fa7b",
      "--zy-syn-regexp": "#ff5555",
      "--zy-syn-variable": "#ffb86c",
      "--zy-syn-delim": "#a4a8c0",
      "--zy-diff-add": "#50fa7b",
      "--zy-diff-add-bg": "rgba(80, 250, 123, 0.08)",
      "--zy-diff-del": "#ff5555",
      "--zy-diff-del-bg": "rgba(255, 85, 85, 0.09)",
      "--zy-diff-hunk": "#8be9fd",
      "--zy-working": "#ff79c6",
    }),
  },
  {
    id: "mono",
    label: "Mono",
    hint: "Greys, with colour only where it means something.",
    vars: palette({
      "--zy-chat-user": "#a1a1aa",
      "--zy-chat-code": "#e4e4e7",
      "--zy-chat-code-bg": "rgba(255, 255, 255, 0.08)",
      "--zy-chat-heading": "#fafafa",
      "--zy-chat-heading-minor": "#d4d4d8",
      "--zy-chat-strong": "#ffffff",
      "--zy-chat-bullet": "#71717a",
      "--zy-chat-quote": "rgba(255, 255, 255, 0.25)",
      "--zy-tool-read": "#d4d4d8",
      "--zy-tool-edit": "#d4d4d8",
      "--zy-tool-terminal": "#d4d4d8",
      "--zy-tool-search": "#d4d4d8",
      "--zy-tool-web": "#d4d4d8",
      "--zy-tool-plan": "#d4d4d8",
      "--zy-tool-agent": "#d4d4d8",
      "--zy-syn-keyword": "#fafafa",
      "--zy-syn-string": "#a1a1aa",
      "--zy-syn-number": "#d4d4d8",
      "--zy-syn-comment": "#52525b",
      "--zy-syn-type": "#e4e4e7",
      "--zy-syn-attr": "#d4d4d8",
      "--zy-syn-regexp": "#a1a1aa",
      "--zy-syn-variable": "#e4e4e7",
      "--zy-syn-delim": "#71717a",
      // Le seul endroit où le gris mentirait : un ajout et un retrait.
      "--zy-diff-add": "#86efac",
      "--zy-diff-add-bg": "rgba(134, 239, 172, 0.06)",
      "--zy-diff-del": "#fca5a5",
      "--zy-diff-del-bg": "rgba(252, 165, 165, 0.06)",
      "--zy-diff-hunk": "#a1a1aa",
      "--zy-working": "#e4e4e7",
    }),
  },
]

export function chatTheme(id: string): ChatTheme {
  return CHAT_THEMES.find((t) => t.id === id) ?? CHAT_THEMES[0]
}

// ---------- l'indicateur « il travaille » ----------

export type WorkingIndicatorId = "sparkle" | "claude" | "braille" | "dots" | "orb" | "bars" | "custom"

export const WORKING_INDICATORS: { id: WorkingIndicatorId; label: string }[] = [
  { id: "sparkle", label: "Sparkle" },
  { id: "claude", label: "Glyphs" },
  { id: "braille", label: "Spinner" },
  { id: "dots", label: "Dots" },
  { id: "orb", label: "Orb" },
  { id: "bars", label: "Equalizer" },
  { id: "custom", label: "Your own" },
]

export type CustomAnimation = "spin" | "pulse" | "bounce" | "none"
export const CUSTOM_ANIMATIONS: CustomAnimation[] = ["spin", "pulse", "bounce", "none"]

/** L'image téléversée, gardée en `data:` dans les réglages : un fichier de
 *  configuration exporté l'emporte avec lui. */
export type CustomIndicator = { dataUrl: string; name: string; animation: CustomAnimation }

// Une image, et rien d'autre : une adresse `data:` d'un type d'image, en base64,
// pas plus grosse qu'il ne faut pour une icône de seize pixels. Un SVG est
// accepté — affiché par <img>, il ne peut rien exécuter.
export const CUSTOM_INDICATOR_MAX = 700_000
const DATA_IMAGE = /^data:image\/(png|gif|webp|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/

export function sanitizeCustomIndicator(raw: unknown): CustomIndicator | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const dataUrl = typeof r.dataUrl === "string" ? r.dataUrl : ""
  if (dataUrl.length > CUSTOM_INDICATOR_MAX || !DATA_IMAGE.test(dataUrl)) return null
  const name = typeof r.name === "string" ? r.name.slice(0, 120) : "custom"
  const animation = CUSTOM_ANIMATIONS.includes(r.animation as CustomAnimation) ? (r.animation as CustomAnimation) : "spin"
  return { dataUrl, name, animation }
}
