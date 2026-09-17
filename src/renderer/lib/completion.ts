import { monaco } from "~/lib/monaco"

// La complétion en ligne : ce qui s'écrit en gris devant le curseur.
//
// Trois choses font qu'une complétion est utile ou insupportable, et aucune ne
// concerne le modèle :
//
// 1. **Elle ne part pas à chaque touche.** On tape plus vite qu'un modèle ne
//    répond ; demander à chaque frappe, c'est payer dix réponses pour en
//    afficher une. On attend un silence.
//
// 2. **La demande d'avant est abandonnée.** Monaco annule lui-même quand le
//    curseur bouge, et il faut que l'abandon aille jusqu'au bout du fil : sinon
//    le serveur continue de calculer une suggestion pour un curseur qui n'est
//    plus là, et la réponse arrive après celle qu'on attendait.
//
// 3. **Elle est éteinte tant que personne ne l'a allumée.** Une complétion
//    part à chaque silence, et chaque départ dépense un compte. Personne ne
//    doit le découvrir sur sa facture.

const IDLE_MS = 350

// La préférence vit dans le navigateur de l'application : c'est un réglage de
// confort, propre à cette machine, pas quelque chose qui appartient au projet.
const STORAGE_KEY = "zyvro.completion.enabled"

let enabled = read()
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on"
  } catch {
    // Un stockage refusé n'est pas une raison de perdre l'éditeur.
    return false
  }
}

export function completionEnabled(): boolean {
  return enabled
}

export function setCompletionEnabled(on: boolean): void {
  enabled = on
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off")
  } catch {
    // Tant pis pour la mémoire, le réglage vaut pour cette session.
  }
  for (const l of listeners) l()
}

export function subscribeCompletion(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// sleep qui se réveille quand on abandonne : attendre un silence ne doit pas
// retarder l'annulation de 350 millisecondes.
function idle(token: monaco.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      done.dispose()
      resolve(true)
    }, IDLE_MS)
    const done = token.onCancellationRequested(() => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

// contextAround lit ce qui entoure le curseur.
//
// Le fichier entier, et c'est le démon qui coupe : il connaît la fenêtre qu'il
// envoie au modèle, et deux endroits qui décideraient de la même coupe
// finiraient par en décider deux différentes.
export function contextAround(
  model: { getValue(): string; getOffsetAt(p: monaco.IPosition): number },
  position: monaco.IPosition
): { prefix: string; suffix: string } {
  const text = model.getValue()
  const offset = model.getOffsetAt(position)
  return { prefix: text.slice(0, offset), suffix: text.slice(offset) }
}

// worthAsking dit quand se taire.
//
// Un fichier vide n'a pas de milieu à remplir : demander ferait écrire au
// modèle une page entière, à chaque silence, pour quelque chose que personne
// n'a commencé. C'est la seule abstention : compléter au milieu d'un mot est
// justement ce qu'on attend d'une complétion.
export function worthAsking(prefix: string, suffix: string): boolean {
  return prefix.trim() !== "" || suffix.trim() !== ""
}

type Asker = (
  body: { prefix: string; suffix: string },
  signal: AbortSignal
) => Promise<{ text?: string } | null>

// install branche la complétion sur Monaco pour toutes les langues.
//
// Rendue plutôt qu'exécutée au chargement : le module se teste alors sans
// éditeur, et l'application décide quand elle l'installe.
export function installCompletion(ask: Asker = askDaemon): monaco.IDisposable {
  return monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      async provideInlineCompletions(model, position, _context, token) {
        if (!enabled) return { items: [] }
        if (!(await idle(token))) return { items: [] }

        const { prefix, suffix } = contextAround(model, position)
        if (!worthAsking(prefix, suffix)) return { items: [] }

        // Le fil de l'abandon : Monaco annule, la requête s'arrête, et le
        // démon voit sa connexion se fermer.
        const controller = new AbortController()
        const stop = token.onCancellationRequested(() => controller.abort())
        try {
          const answer = await ask({ prefix, suffix }, controller.signal)
          const text = answer?.text ?? ""
          if (!text || token.isCancellationRequested) return { items: [] }
          return { items: [{ insertText: text, range: rangeAt(position) }] }
        } catch {
          // Une complétion qui échoue ne dit rien : elle part à chaque silence,
          // et un message par échec ferait clignoter l'éditeur.
          return { items: [] }
        } finally {
          stop.dispose()
        }
      },
      freeInlineCompletions() {
        // Rien à libérer : les suggestions sont des chaînes.
      },
    }
  )
}

function rangeAt(position: monaco.IPosition): monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  }
}

async function askDaemon(body: { prefix: string; suffix: string }, signal: AbortSignal) {
  const res = await fetch("http://127.0.0.1:0/api/completion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  // 204 : le démon a vu l'abandon avant nous.
  if (res.status === 204 || !res.ok) return null
  return (await res.json()) as { text?: string }
}
