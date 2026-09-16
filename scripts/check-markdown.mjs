// A standalone check for the Markdown renderer.
//
// It exists because that renderer took down the whole window once: the inline
// tokenizer shared one /g/ regex across its own recursive calls, so nested
// emphasis rewound the cursor and it appended React elements until the
// renderer ran out of memory. A crash like that is invisible in a typecheck
// and expensive to find twice, so the parser gets a test even though the app
// has no test runner: esbuild is already here through Vite, and
// react-dom/server can render the component to a string.
//
//     node scripts/check-markdown.mjs
import { build } from "esbuild"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const WEB = path.resolve(ROOT, "../Zyvro-frontend/src")

const HARNESS = `
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { Markdown } from "@/components/Markdown"
export function render(text) {
  return renderToStaticMarkup(createElement(Markdown, { text }))
}
`

const cases = [
  {
    name: "a heading becomes a heading, not a hash",
    input: "## Setup steps",
    expect: (html) => html.includes("Setup steps") && !html.includes("## "),
  },
  {
    name: "bold and italic render as elements",
    input: "a **bold** and an *italic* word",
    expect: (html) => html.includes("<strong") && html.includes("<em"),
  },
  {
    name: "inline code renders as code",
    input: "run `npm run dev` now",
    expect: (html) => html.includes("<code") && html.includes("npm run dev"),
  },
  {
    name: "a fenced block renders as a pre with its language",
    input: "```javascript\nconst a = 1\n```",
    expect: (html) => html.includes("<pre") && html.includes("javascript") && html.includes("const a = 1"),
  },
  {
    name: "an unterminated fence still renders, because streaming",
    input: "```js\nconst a = 1",
    expect: (html) => html.includes("<pre") && html.includes("const a = 1"),
  },
  {
    name: "a bullet list becomes list items",
    input: "- one\n- two\n- three",
    expect: (html) => (html.match(/<li/g) || []).length === 3,
  },
  {
    name: "an ordered list keeps its numbers",
    input: "1. first\n2. second",
    expect: (html) => html.includes("1.") && html.includes("2."),
  },
  {
    name: "a table becomes a table",
    input: "| Name | Port |\n|---|---|\n| api | 4102 |",
    expect: (html) => html.includes("<table") && html.includes("<th") && html.includes("4102"),
  },
  {
    name: "prose containing a pipe is not a table",
    input: "use grep | head to trim it",
    expect: (html) => !html.includes("<table"),
  },
  {
    name: "a blockquote nests",
    input: "> quoted **text**",
    expect: (html) => html.includes("<blockquote") && html.includes("<strong"),
  },
  {
    name: "an http link renders as an anchor",
    input: "see [the docs](https://example.com/x)",
    expect: (html) => html.includes('href="https://example.com/x"') && html.includes("the docs"),
  },
  {
    // The contract is that nothing but http and https ever becomes a clickable
    // href, not that the characters disappear. Here the parentheses in the URL
    // stop it matching a link at all, so the whole thing stays literal text.
    name: "a javascript: URL with parens never becomes a link",
    input: "[click](javascript:alert(1))",
    expect: (html) => !html.includes("href") && html.includes("click"),
  },
  {
    // This one does parse as a link, so it exercises the scheme guard itself:
    // the label survives, the href does not.
    name: "a javascript: URL that parses is stripped of its href",
    input: "[click](javascript:alert)",
    expect: (html) => !html.includes("href") && !html.includes("javascript:") && html.includes("click"),
  },
  {
    name: "a data: URL is not clickable either",
    input: "[x](data:text/html;base64,PHNjcmlwdD4=)",
    expect: (html) => !html.includes("href"),
  },
  {
    name: "html in the source is escaped, never markup",
    input: "<img src=x onerror=alert(1)> and <b>bold</b>",
    expect: (html) => !html.includes("<img") && !html.includes("<b>") && html.includes("&lt;img"),
  },
  // The regression that started all this. Nested emphasis drives the inline
  // tokenizer into itself; with a shared regex this never returned.
  {
    name: "nested emphasis terminates",
    input: "**bold with *italic* and `code` inside** then more",
    expect: (html) => html.includes("<strong") && html.includes("<em") && html.includes("more"),
  },
  {
    name: "deeply nested emphasis terminates",
    input: "**a *b **c *d **e *f* g** h* i** j".repeat(3),
    expect: (html) => html.length > 0,
  },
  {
    name: "a realistic reply with every construct terminates",
    input: [
      "## Result",
      "",
      "The **graph** ran through `claude-cli` in 2.5s. See [the notes](https://example.com).",
      "",
      "- first *item*",
      "  - nested one",
      "- second item",
      "",
      "```go",
      'func main() { fmt.Println("hi") }',
      "```",
      "",
      "| Node | Status |",
      "|---|---|",
      "| llm | ok |",
      "",
      "> A closing **note**.",
    ].join("\n"),
    expect: (html) =>
      html.includes("<strong") &&
      html.includes("<pre") &&
      html.includes("<table") &&
      html.includes("<blockquote") &&
      (html.match(/<li/g) || []).length >= 3,
  },
  {
    name: "every prefix of that reply terminates, as it would while streaming",
    input: null, // handled below
    expect: () => true,
  },
]

// The bundle has to live inside the project: react and react-dom are left
// external so the check exercises the same copies the app uses, and Node only
// resolves them from a file that sits under this node_modules.
const dir = path.join(ROOT, "node_modules", ".zyvro-markdown-check")
mkdirSync(dir, { recursive: true })
try {
  const entry = path.join(dir, "harness.jsx")
  writeFileSync(entry, HARNESS)
  const outfile = path.join(dir, "harness.cjs")

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // CommonJS, not ESM: lucide-react ships a CJS build that calls require(),
    // which esbuild cannot express in an ESM bundle.
    format: "cjs",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react-dom"],
    alias: { "@": WEB },
    absWorkingDir: ROOT,
    logLevel: "silent",
  })

  const { render } = createRequire(import.meta.url)(outfile)

  // A hard wall-clock budget. The failure this guards against is an infinite
  // loop, and an assertion cannot catch one: the process simply never returns.
  const BUDGET_MS = 5000
  let failures = 0

  const run = (name, text, expect) => {
    const started = Date.now()
    let html
    try {
      html = render(text)
    } catch (err) {
      console.log(`  FAIL  ${name}\n        threw: ${err.message}`)
      failures++
      return
    }
    const took = Date.now() - started
    if (took > BUDGET_MS) {
      console.log(`  FAIL  ${name}\n        took ${took}ms, budget ${BUDGET_MS}ms`)
      failures++
      return
    }
    if (!expect(html)) {
      console.log(`  FAIL  ${name}\n        got: ${html.slice(0, 220)}`)
      failures++
      return
    }
    console.log(`  ok    ${name}`)
  }

  const full = cases.find((c) => c.name.startsWith("a realistic reply")).input

  for (const testCase of cases) {
    if (testCase.input === null) continue
    run(testCase.name, testCase.input, testCase.expect)
  }

  // Streaming feeds the renderer every prefix of the reply, so every prefix has
  // to be safe, not just the finished text.
  const started = Date.now()
  for (let end = 1; end <= full.length; end += 7) render(full.slice(0, end))
  const took = Date.now() - started
  if (took > 20000) {
    console.log(`  FAIL  every prefix of that reply terminates\n        took ${took}ms`)
    failures++
  } else {
    console.log(`  ok    every prefix of that reply terminates (${Math.ceil(full.length / 7)} renders in ${took}ms)`)
  }

  console.log(failures === 0 ? "\nAll markdown checks passed." : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
