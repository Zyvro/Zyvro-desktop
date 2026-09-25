import * as monaco from "monaco-editor"
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker"
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker"
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker"
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker"

// Monaco needs its language services in web workers, and Vite needs to be told
// which bundle each one is. Doing it at import time means the first editor to
// open already has them.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker()
      case "css":
      case "scss":
      case "less":
        return new cssWorker()
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker()
      case "typescript":
      case "javascript":
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

// The theme is defined against the app's own palette rather than one of the
// stock Monaco themes, so the editor does not read as a widget pasted into a
// different product.
monaco.editor.defineTheme("zyvro-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6b6b7b", fontStyle: "italic" },
    { token: "keyword", foreground: "a78bfa" },
    { token: "string", foreground: "5eead4" },
    { token: "number", foreground: "fbbf24" },
    { token: "type", foreground: "7dd3fc" },
    { token: "delimiter", foreground: "9ca3af" },
  ],
  colors: {
    "editor.background": "#0b0b0f",
    "editor.foreground": "#f5f5f5",
    "editorLineNumber.foreground": "#4b4b57",
    "editorLineNumber.activeForeground": "#9ca3af",
    "editor.selectionBackground": "#4f46e540",
    "editor.lineHighlightBackground": "#ffffff08",
    "editorCursor.foreground": "#a78bfa",
    "editorIndentGuide.background1": "#ffffff10",
    "editorWidget.background": "#16161c",
    "editorWidget.border": "#2a2a33",
    "editorSuggestWidget.background": "#16161c",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff22",
  },
})

// TypeScript et JavaScript, réglés pour un éditeur qui ne voit pas
// `node_modules`.
//
// Monaco vérifie chaque fichier ouvert seul, sans le projet autour : chaque
// `import` d'un paquet y devenait « Cannot find module 'react' », et le panneau
// Problems s'en remplissait jusqu'à cacher les vraies erreurs. Ces codes-là —
// ce que seul le projet entier saurait résoudre — sont tus ; les fautes de
// frappe, de syntaxe et de types restent. Et le JSX est compris dans un
// `.tsx`, maintenant que chaque modèle porte le nom de son fichier.
const IGNORES = [
  2307, // Cannot find module
  2792, // Cannot find module, did you mean to set moduleResolution
  7016, // Could not find a declaration file for module
  2875, // This JSX tag requires the module path … to exist
]
for (const defaults of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
  defaults.setCompilerOptions({
    ...defaults.getCompilerOptions(),
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
  })
  defaults.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), diagnosticCodesToIgnore: IGNORES })
}

// modelUri : l'adresse du modèle d'un fichier du projet. Le chemin relatif, en
// `file:///` : c'est ce qui dit à TypeScript qu'un `.tsx` contient du JSX, et
// ce qui permet au panneau Problems de dire de quel fichier vient une erreur.
export function modelUri(path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "file", path: `/${path}` })
}

/** L'inverse de `modelUri`, ou null pour un modèle qui n'est pas un fichier. */
export function pathOfUri(uri: monaco.Uri): string | null {
  return uri.scheme === "file" ? uri.path.replace(/^\//, "") : null
}

// formatDocument : le formateur de Monaco pour le langage du fichier — ceux
// qu'il embarque : TypeScript et JavaScript, JSON, CSS, SCSS, Less, HTML. Pour
// un autre langage, rien ne change : pas d'erreur, le texte reste tel quel.
export async function formatDocument(editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
  const action = editor.getAction("editor.action.formatDocument")
  if (!action?.isSupported()) return
  try {
    await action.run()
  } catch {
    // Un formateur qui échoue n'empêche pas d'enregistrer.
  }
}

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  zyvro: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  go: "go",
  py: "python",
  rs: "rust",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  sql: "sql",
  xml: "xml",
  dockerfile: "dockerfile",
}

export function languageFor(path: string): string {
  const name = path.split("/").pop() ?? path
  if (name.toLowerCase().startsWith("dockerfile")) return "dockerfile"
  if (name === ".gitignore" || name === ".env" || name.startsWith(".env.")) return "ini"
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  return BY_EXTENSION[ext] ?? "plaintext"
}

export { monaco }
