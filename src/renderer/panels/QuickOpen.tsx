import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { useQuery } from "@tanstack/react-query"
import { Loader2, SquareTerminal } from "lucide-react"
import { FileTypeIcon } from "~/lib/fileIcons"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { revealAt } from "~/state/reveal"
import { formatAccelerator, rank, splitLine } from "../../shared/fuzzy"

// Quick Open (⌘P) : taper quelques lettres d'un nom de fichier et l'ouvrir.
//
// Le geste le plus fréquent d'un éditeur après taper du texte, et celui qui
// manquait le plus : sans lui, ouvrir un fichier voulait dire déplier l'arbre
// dossier par dossier. La liste vient du principal, qui parcourt le projet
// avec les mêmes dossiers cachés que la recherche ; le tri est flou, comme
// dans VS Code (`shared/fuzzy`).
//
// Requête vide : les onglets ouverts et les fichiers récemment fermés, parce
// qu'on rouvre bien plus souvent qu'on ne découvre. `chemin:42` ouvre à la
// ligne 42 — ce qu'on copie d'une trace d'erreur.
//
// Et `>` en tête, c'est la palette de commandes (⌘⇧P) : la même boîte, comme
// dans VS Code, sur la liste du menu de l'application — lue au principal, pour
// qu'une commande et son raccourci ne soient écrits qu'à un endroit.

let ouvert = false
let depart = ""
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Ouvrir Quick Open depuis n'importe où : le menu, un raccourci, un bouton.
 * `initial` est ce qui est déjà tapé — `>` pour la palette de commandes.
 */
export function openQuickOpen(initial = ""): void {
  // Sans projet, pas de fichiers à chercher ; les commandes, elles, existent.
  if (!initial.startsWith(">") && !useWorkspace.getState().project) return
  depart = initial
  ouvert = true
  emit()
}

function fermer(): void {
  ouvert = false
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const isOpen = () => ouvert

export function QuickOpen() {
  const open = useSyncExternalStore(subscribe, isOpen, isOpen)
  // Remonté à chaque ouverture : la requête et la sélection repartent de zéro
  // sans effet qui les surveille.
  return open ? <QuickOpenDialog /> : null
}

function Surligne({ texte, positions, debut }: { texte: string; positions: Set<number>; debut: number }) {
  return (
    <>
      {[...texte].map((c, i) =>
        positions.has(debut + i) ? (
          <span key={i} className="font-semibold text-sky-300">
            {c}
          </span>
        ) : (
          <span key={i}>{c}</span>
        )
      )}
    </>
  )
}

function QuickOpenDialog() {
  const [saisie, setSaisie] = useState(depart)
  const [choisi, setChoisi] = useState(0)
  const project = useWorkspace((s) => s.project)
  const tabs = useWorkspace((s) => s.tabs)
  const closedFiles = useWorkspace((s) => s.closedFiles)

  // Relue à chaque ouverture, mais servie tout de suite depuis le cache : la
  // liste d'il y a une minute vaut mieux qu'une boîte vide le temps du
  // parcours.
  const liste = useQuery({
    queryKey: ["files", "all", project?.project],
    queryFn: () => window.zyvro.files.all(),
    enabled: Boolean(project),
    staleTime: 0,
  })

  const recents = useMemo(() => {
    const vus = new Set<string>()
    const out: string[] = []
    const ajouter = (p: string) => {
      if (!vus.has(p)) {
        vus.add(p)
        out.push(p)
      }
    }
    for (const tab of tabs) if (tab.kind === "file") ajouter(tab.path)
    for (const p of [...closedFiles].reverse()) ajouter(p)
    return out
  }, [tabs, closedFiles])

  const commandes = saisie.startsWith(">")
  const menu = useQuery({
    queryKey: ["menu", "list"],
    queryFn: () => window.zyvro.menu.list(),
    enabled: commandes,
    staleTime: 0,
  })
  const trouvees = useMemo(() => {
    if (!commandes) return []
    const liste = menu.data ?? []
    const q = saisie.slice(1).trim()
    // Classées sur « Groupe › Libellé » : taper `view term` trouve Toggle
    // Terminal dans View. Le libellé seul décide des lettres surlignées.
    const parId = new Map(liste.map((c) => [c.id, c]))
    return rank(q, liste.map((c) => c.id), 80).map((r) => parId.get(r.path)!)
  }, [commandes, saisie, menu.data])

  const { query, line, column } = splitLine(saisie.trim())
  const resultats = useMemo(() => {
    if (commandes) return []
    if (query === "") return recents.map((path) => ({ path, positions: [] as number[] }))
    // Les récents d'abord dans la liste donnée au tri : à score égal, ils
    // passent devant.
    const tous = [...recents, ...(liste.data?.files ?? []).filter((p) => !recents.includes(p))]
    return rank(query, tous, 60)
  }, [commandes, query, recents, liste.data])

  const total = commandes ? trouvees.length : resultats.length
  const index = Math.min(choisi, Math.max(0, total - 1))

  const executer = (id: string) => {
    fermer()
    void window.zyvro.menu.run(id)
  }

  const ouvrir = (path: string) => {
    fermer()
    useWorkspace.getState().openFile(path)
    if (line !== null) {
      revealAt({ path, line: Math.max(0, line - 1), column: Math.max(0, (column ?? 1) - 1), length: 0 })
    }
  }

  const focusInput = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
  }, [])

  // La ligne choisie reste visible quand on descend au clavier.
  const suivre = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" })
  }, [])

  return (
    <Dialog.Root open onOpenChange={(o) => !o && fermer()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="panel fixed left-1/2 top-[12%] z-50 flex max-h-[60vh] w-[600px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Dialog.Title className="sr-only">Go to File</Dialog.Title>
          <Dialog.Description className="sr-only">Type part of a file name to open it.</Dialog.Description>
          <input
            ref={focusInput}
            className="h-10 w-full border-b border-white/10 bg-transparent px-3 text-sm outline-none"
            placeholder={
              commandes ? "Type a command" : "Search files by name (append :line to go to a line, or start with > for commands)"
            }
            value={saisie}
            onChange={(event) => {
              setSaisie(event.target.value)
              setChoisi(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setChoisi((i) => Math.min(i + 1, total - 1))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setChoisi((i) => Math.max(i - 1, 0))
              } else if (event.key === "Enter") {
                event.preventDefault()
                if (commandes) {
                  const commande = trouvees[index]
                  if (commande) executer(commande.id)
                  return
                }
                const cible = resultats[index]
                if (cible) ouvrir(cible.path)
              }
            }}
          />
          <div className="zy-scroll min-h-0 flex-1 overflow-y-auto py-1">
            {commandes && !menu.isLoading && trouvees.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-muted-foreground">No matching commands.</p>
            )}
            {trouvees.map((c, i) => (
              <button
                key={c.id}
                ref={i === index ? suivre : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]",
                  i === index ? "bg-white/[0.09]" : "hover:bg-white/[0.05]"
                )}
                onMouseMove={() => setChoisi(i)}
                onClick={() => executer(c.id)}
              >
                <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {c.group && <span className="text-muted-foreground">{c.group}: </span>}
                  {c.label}
                </span>
                {c.accelerator && (
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                    {formatAccelerator(c.accelerator, window.zyvro.platform)}
                  </span>
                )}
              </button>
            ))}
            {!commandes && liste.isLoading && query !== "" && (
              <p className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3 w-3 zy-spin" /> Listing the project…
              </p>
            )}
            {!commandes && !liste.isLoading && resultats.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-muted-foreground">
                {query === "" ? "Type to search the project's files." : "No matching files."}
              </p>
            )}
            {resultats.map((r, i) => {
              const coupe = r.path.lastIndexOf("/") + 1
              const nom = r.path.slice(coupe)
              const dossier = r.path.slice(0, Math.max(0, coupe - 1))
              const positions = new Set(r.positions)
              return (
                <button
                  key={r.path}
                  ref={i === index ? suivre : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px]",
                    i === index ? "bg-white/[0.09]" : "hover:bg-white/[0.05]"
                  )}
                  onMouseMove={() => setChoisi(i)}
                  onClick={() => ouvrir(r.path)}
                >
                  <FileTypeIcon name={nom} className="h-3.5 w-3.5" />
                  <span className="shrink-0">
                    <Surligne texte={nom} positions={positions} debut={coupe} />
                  </span>
                  <span className="truncate text-[12px] text-muted-foreground">
                    <Surligne texte={dossier} positions={positions} debut={0} />
                  </span>
                </button>
              )
            })}
            {liste.data?.truncated && (
              <p className="px-3 py-1 text-[11px] text-muted-foreground">
                This project is large: only the first {liste.data.files.length.toLocaleString()} files are searched.
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
