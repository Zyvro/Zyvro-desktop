// La complétion en ligne, exercée sans éditeur.
//
// Ce qui rend une complétion insupportable ne vient pas du modèle, et ne se
// voit pas en regardant l'écran :
//
// 1. **Une requête par frappe.** On tape plus vite qu'un modèle ne répond. Sans
//    attente de silence, on paie dix réponses pour en afficher une, et on ne
//    s'en aperçoit qu'à la facture.
//
// 2. **Une demande abandonnée qui continue.** Monaco annule dès que le curseur
//    bouge ; si l'abandon ne descend pas jusqu'à la requête, le serveur calcule
//    pour un curseur qui n'existe plus, et sa réponse arrive après la bonne.
//
// 3. **Un interrupteur qui ne coupe rien.** « Éteint » doit vouloir dire
//    qu'aucune requête ne part — pas qu'on jette la réponse.
//
//     node scripts/check-completion.mjs
import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const ROOT = path.resolve(import.meta.dirname, "..")
const dir = path.join(ROOT, "node_modules", ".zyvro-completion-check")
mkdirSync(dir, { recursive: true })

// Monaco est remplacé : on ne teste pas son éditeur, on teste ce qu'on lui
// donne. Le faux enregistre le fournisseur pour qu'on puisse l'appeler comme
// il le ferait.
writeFileSync(
  path.join(dir, "monaco.ts"),
  `export const monaco: any = {
     languages: {
       registered: null as any,
       registerInlineCompletionsProvider(_sel: unknown, provider: unknown) {
         ;(monaco.languages as any).registered = provider
         return { dispose() {} }
       },
     },
   }\n`
)
writeFileSync(
  path.join(dir, "h.ts"),
  `export * from "${path.join(ROOT, "src/renderer/lib/completion").replace(/\\/g, "/")}"\n` +
    `export { monaco } from "${path.join(dir, "monaco").replace(/\\/g, "/")}"\n`
)
await build({
  entryPoints: [path.join(dir, "h.ts")],
  outfile: path.join(dir, "h.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  absWorkingDir: ROOT,
  logLevel: "silent",
  alias: { "~/lib/monaco": path.join(dir, "monaco"), "~": path.join(ROOT, "src/renderer") },
})

// localStorage : la préférence s'y range, et son absence ne doit pas casser.
globalThis.window = { localStorage: new Map() }
window.localStorage.getItem = function (k) {
  return Map.prototype.get.call(this, k) ?? null
}
window.localStorage.setItem = function (k, v) {
  Map.prototype.set.call(this, k, v)
}

const mod = createRequire(import.meta.url)(path.join(dir, "h.cjs"))

let failures = 0
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ok    ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`)
    failures++
  }
}

// Un faux jeton d'annulation, comme Monaco en passe un.
function token() {
  const handlers = []
  return {
    isCancellationRequested: false,
    onCancellationRequested(fn) {
      handlers.push(fn)
      return { dispose() {} }
    },
    cancel() {
      this.isCancellationRequested = true
      for (const fn of handlers) fn()
    },
  }
}

const model = (text, offset) => ({ getValue: () => text, getOffsetAt: () => offset })
const position = { lineNumber: 1, column: 1 }

// ---- ce qu'on envoie ----------------------------------------------------
{
  const { prefix, suffix } = mod.contextAround(model("abcdef", 3), position)
  check("le curseur coupe le fichier en deux", prefix === "abc" && suffix === "def", `${prefix}|${suffix}`)
  check("un fichier vide ne vaut pas la peine d'être complété", mod.worthAsking("  ", "\n") === false)
  check("dès qu'il y a quelque chose autour, on demande", mod.worthAsking("const x", "") === true)
}

// ---- l'interrupteur -----------------------------------------------------
{
  mod.setCompletionEnabled(false)
  let asked = 0
  mod.installCompletion(async () => {
    asked++
    return { text: "jamais" }
  })
  const provider = mod.monaco.languages.registered
  const out = await provider.provideInlineCompletions(model("const x = ", 10), position, {}, token())
  check("**éteint, aucune requête ne part**", asked === 0, `${asked} requête(s)`)
  check("et rien ne s'affiche", out.items.length === 0)
}

// ---- le silence avant la demande ----------------------------------------
{
  mod.setCompletionEnabled(true)
  let asked = 0
  mod.installCompletion(async () => {
    asked++
    return { text: "1" }
  })
  const provider = mod.monaco.languages.registered

  // La frappe continue : le jeton est annulé avant la fin du silence.
  const t = token()
  const pending = provider.provideInlineCompletions(model("const x = ", 10), position, {}, t)
  t.cancel()
  const out = await pending
  check("**une frappe qui continue annule la demande d'avant**", asked === 0, `${asked} requête(s)`)
  check("et n'affiche rien", out.items.length === 0)

  // Laissé tranquille, il demande.
  const quiet = await provider.provideInlineCompletions(model("const x = ", 10), position, {}, token())
  check("après un silence, la demande part", asked === 1, `${asked} requête(s)`)
  check("et la suggestion s'insère au curseur", quiet.items[0]?.insertText === "1", JSON.stringify(quiet.items))
  check(
    "sur une plage vide, donc elle ajoute au lieu de remplacer",
    quiet.items[0]?.range.startColumn === quiet.items[0]?.range.endColumn
  )
}

// ---- l'abandon descend jusqu'à la requête -------------------------------
{
  mod.setCompletionEnabled(true)
  let aborted = false
  mod.installCompletion(
    (_body, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
        setTimeout(() => resolve({ text: "trop tard" }), 5000)
      })
  )
  const provider = mod.monaco.languages.registered
  const t = token()
  const pending = provider.provideInlineCompletions(model("const x = ", 10), position, {}, t)
  await new Promise((r) => setTimeout(r, 450))
  t.cancel()
  const out = await pending
  check("**l'abandon atteint la requête en cours**", aborted, "le serveur calculerait pour un curseur disparu")
  check("une demande abandonnée n'affiche rien", out.items.length === 0)
}

// ---- une panne ne parle pas ---------------------------------------------
{
  mod.setCompletionEnabled(true)
  mod.installCompletion(async () => {
    throw new Error("le serveur est éteint")
  })
  const provider = mod.monaco.languages.registered
  const out = await provider.provideInlineCompletions(model("x = ", 4), position, {}, token())
  check("une complétion qui échoue se tait", out.items.length === 0)
}

console.log(failures === 0 ? "\nLa complétion ne part qu'au silence, et s'arrête quand on tape." : `\n${failures} échec(s)`)
process.exit(failures === 0 ? 0 : 1)
