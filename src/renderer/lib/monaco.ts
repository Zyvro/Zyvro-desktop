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
