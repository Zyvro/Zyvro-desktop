import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FilePlus2,
  FolderPlus,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { DirEntry } from "../../preload"
import { useWorkspace } from "~/state/workspace"
import { askName } from "~/state/prompt"
import { subscribeFiles, unwatchDir, versionOf, watchDir } from "~/state/fileWatch"
import { ZYVRO_PATH } from "../../shared/dropped"
import { EntryMenu } from "~/panels/EntryMenu"

// The file tree loads one directory at a time. Reading the whole project up
// front would be fine for a small folder and unusable for a real repository,
// and the user only ever looks at the branches they open.

function dirKey(path: string) {
  return ["files", "list", path] as const
}

const FILE_TINT: Record<string, string> = {
  ts: "text-sky-300",
  tsx: "text-sky-300",
  js: "text-amber-300",
  jsx: "text-amber-300",
  json: "text-amber-200",
  go: "text-cyan-300",
  md: "text-blue-200",
  css: "text-fuchsia-300",
  py: "text-emerald-300",
  zyvro: "text-violet-300",
}

function tintFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return FILE_TINT[ext] ?? "text-muted-foreground"
}

// ROW_HEIGHT : la hauteur d'une ligne, en pixels, et elle doit être exacte.
//
// C'est elle qui permet de ne dessiner que ce qu'on voit : la position d'une
// ligne est son rang fois cette hauteur, sans avoir à mesurer quoi que ce soit.
// Mesurée sur une vraie ligne plutôt que déduite de la feuille de style —
// `py-[3px]` et `leading-5` font 26, et se tromper d'un pixel ferait dériver
// l'ascenseur de vingt-huit mille pixels au bout d'un gros dossier.
export const ROW_HEIGHT = 26

// Combien de lignes dessiner au-delà du cadre, de chaque côté. Assez pour
// qu'un coup de molette ne montre pas de vide avant le rendu suivant, assez peu
// pour que ça reste trois fois rien.
export const OVERSCAN = 8

/** Une ligne de l'arbre, telle qu'elle sera dessinée : ce qu'elle montre et à
 *  quelle profondeur. L'arbre est récursif, la liste ne l'est pas — et c'est
 *  ce qui permet de n'en dessiner qu'une tranche. */
export type Ligne = { entry: DirEntry; depth: number }

// aplatir déroule l'arbre ouvert en une liste.
//
// Un arbre de composants récursifs ne se virtualise pas : chaque nœud décide de
// ses enfants, donc personne ne sait combien de lignes il y a ni où commence la
// centième. Une liste, si.
export function aplatir(
  parDossier: Map<string, DirEntry[]>,
  expanded: Set<string>,
  chemin: string,
  depth: number,
  out: Ligne[]
): void {
  for (const entry of parDossier.get(chemin) ?? []) {
    out.push({ entry, depth })
    if (entry.kind === "directory" && expanded.has(entry.path)) {
      aplatir(parDossier, expanded, entry.path, depth + 1, out)
    }
  }
}

function Row({
  entry,
  depth,
  isOpen,
  isActive,
  chargement,
  onToggle,
  onOpen,
  onMenu,
  root,
}: {
  entry: DirEntry
  depth: number
  isOpen: boolean
  isActive: boolean
  chargement: boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onMenu: (entry: DirEntry, at: { x: number; y: number }) => void
  root: string | null
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] leading-5",
        isActive ? "bg-white/[0.08] text-foreground" : "text-foreground/80 hover:bg-white/[0.05]"
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => (entry.kind === "directory" ? onToggle(entry.path) : onOpen(entry.path))}
      title={entry.path}
      // Sans ça, Electron ouvre le sien par-dessus : vérifié, un
      // `preventDefault` ici suffit à l'en empêcher.
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(entry, { x: event.clientX, y: event.clientY })
      }}
      // Attraper un fichier ici et le lâcher sur le chat ou sur le terminal y
      // écrit son chemin. En absolu : il part vers un shell ou vers un agent,
      // et ni l'un ni l'autre ne sait d'où l'arbre compte ses chemins.
      draggable={Boolean(root)}
      onDragStart={(event) => {
        if (!root) return
        const absolute = `${root.replace(/\/$/, "")}/${entry.path}`
        // Notre type dit « ceci est un fichier désigné » ; le `text/plain`
        // qui l'accompagne est ce que toute autre application comprendra.
        event.dataTransfer.setData(ZYVRO_PATH, absolute)
        event.dataTransfer.setData("text/plain", absolute)
        event.dataTransfer.effectAllowed = "copy"
      }}
    >
      {entry.kind === "directory" ? (
        isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <FileIcon className={cn("h-3.5 w-3.5 shrink-0", tintFor(entry.name))} />
      )}
      <span className="truncate">{entry.name}</span>
      {chargement && <Loader2 className="ml-auto h-3 w-3 shrink-0 zy-spin opacity-60" />}
    </button>
  )
}

export function Explorer() {
  const project = useWorkspace((s) => s.project)
  const openFile = useWorkspace((s) => s.openFile)
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const client = useQueryClient()

  // Un seul menu contextuel pour tout l'arbre, et ce qu'il vise.
  //
  // Il y en avait un par ligne. Sur un dossier de vingt-huit mille fichiers,
  // c'étaient vingt-huit mille menus repliés dans le DOM — mesuré : 171 851
  // nœuds et douze secondes pour ouvrir un dossier. Un menu contextuel ne peut
  // de toute façon être ouvert qu'à un endroit à la fois.
  const [menu, setMenu] = useState<{ entry: DirEntry; at: { x: number; y: number } } | null>(null)

  // Ouvrir un dossier, c'est aussi demander à le surveiller ; le replier, c'est
  // cesser. La surveillance suit donc exactement ce qui est affiché, et rien de
  // plus : un `node_modules` replié ne coûte rien.
  const toggle = useMemo(
    () => (path: string) =>
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) {
          next.delete(path)
          unwatchDir(path)
        } else {
          next.add(path)
          watchDir(path)
        }
        return next
      }),
    []
  )

  // La racine est ouverte par définition. Un ref de rappel plutôt qu'un effet :
  // React 18 ignore ce que rend un ref, donc le démontage est garé dans un ref
  // à lui — c'est la forme que ce dépôt emploie là où d'autres écriraient un
  // `useEffect`.
  const stopRoot = useRef<(() => void) | null>(null)
  const watchRoot = (node: HTMLDivElement | null): void => {
    if (node) {
      watchDir(".")
      stopRoot.current = () => unwatchDir(".")
      return
    }
    stopRoot.current?.()
    stopRoot.current = null
  }

  // Une requête par dossier ouvert, décidées ici plutôt que par chaque ligne.
  //
  // Elles vivaient dans les lignes, une par dossier affiché, et c'était très
  // bien tant que chaque ligne existait. Une liste virtualisée ne dessine plus
  // que ce qu'on voit : la ligne d'un dossier ouvert peut être hors cadre, et
  // sa requête partirait avec elle — l'arbre se replierait en défilant.
  //
  // `useQueries` parce que leur nombre change à chaque ouverture, ce qu'une
  // suite de `useQuery` ne sait pas faire.
  const ouverts = useMemo(() => [".", ...[...expanded].sort()], [expanded])
  // La version de chaque dossier fait partie de sa clé : quand le disque bouge,
  // c'est une requête nouvelle, et personne n'a rien à invalider.
  useSyncExternalStore(
    subscribeFiles,
    () => ouverts.map((chemin) => `${chemin}:${versionOf(chemin)}`).join("|"),
    () => ""
  )
  const listes = useQueries({
    queries: ouverts.map((chemin) => ({
      queryKey: [...dirKey(chemin), versionOf(chemin)],
      queryFn: () => window.zyvro.files.list(chemin),
      enabled: Boolean(project),
      staleTime: 5000,
    })),
  })

  const parDossier = useMemo(() => {
    const carte = new Map<string, DirEntry[]>()
    ouverts.forEach((chemin, index) => carte.set(chemin, listes[index]?.data ?? []))
    return carte
  }, [ouverts, listes])

  const lignes = useMemo(() => {
    const out: Ligne[] = []
    aplatir(parDossier, expanded, ".", 0, out)
    return out
  }, [parDossier, expanded])

  const enCours = new Set(ouverts.filter((_, index) => listes[index]?.isFetching))
  const racine = listes[0]

  // Ce qu'on voit du défilement. Deux nombres, et ils suffisent : la hauteur
  // d'une ligne est fixe, donc la première ligne visible est une division.
  const [scrollTop, setScrollTop] = useState(0)
  const [hauteur, setHauteur] = useState(600)
  const mesurer = (node: HTMLDivElement | null): void => {
    if (node) setHauteur(node.clientHeight || 600)
  }

  if (!project) {
    return <p className="px-3 py-2 text-[13px] text-muted-foreground">No project open.</p>
  }

  const premiere = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const derniere = Math.min(lignes.length, Math.ceil((scrollTop + hauteur) / ROW_HEIGHT) + OVERSCAN)
  const visibles = lignes.slice(premiere, derniere)

  const create = async (kind: "file" | "directory") => {
    const name = await askName({
      title: kind === "file" ? "New file" : "New folder",
      label: "Relative to the project root. Slashes create folders along the way.",
      initial: kind === "file" ? "untitled.txt" : "new-folder",
    })
    if (!name) return
    await window.zyvro.files.create(name, kind)
    await client.invalidateQueries({ queryKey: ["files", "list"] })
    if (kind === "file") useWorkspace.getState().openFile(name)
  }

  return (
    <div ref={watchRoot} className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {project.name}
        </span>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="New file"
          onClick={() => void create("file")}
        >
          <FilePlus2 className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="New folder"
          onClick={() => void create("directory")}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title="Refresh"
          onClick={() => void client.invalidateQueries({ queryKey: ["files", "list"] })}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", enCours.size > 0 && "zy-spin")} />
        </button>
      </header>

      {/* Seules les lignes qu'on voit sont dessinées. Le reste est deux
          remplissages, un au-dessus et un en dessous : l'ascenseur a la bonne
          taille et la bonne position sans qu'aucune de ces lignes n'existe. */}
      <div
        ref={mesurer}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="zy-scroll min-h-0 flex-1 overflow-y-auto pb-2 pr-1"
      >
        {racine?.isError && (
          <p className="px-3 py-2 text-[13px] text-destructive">{(racine.error as Error).message}</p>
        )}
        <div style={{ paddingTop: premiere * ROW_HEIGHT, paddingBottom: (lignes.length - derniere) * ROW_HEIGHT }}>
          {visibles.map(({ entry, depth }) => (
            <Row
              key={entry.path}
              entry={entry}
              depth={depth}
              isOpen={expanded.has(entry.path)}
              isActive={activeTabId === `file:${entry.path}`}
              chargement={entry.kind === "directory" && enCours.has(entry.path)}
              onToggle={toggle}
              onOpen={openFile}
              onMenu={(cible, at) => setMenu({ entry: cible, at })}
              root={project.project}
            />
          ))}
        </div>
      </div>

      {menu && (
        <EntryMenu
          entry={menu.entry}
          root={project.project}
          open
          at={menu.at}
          onOpenChange={(ouvert) => {
            if (!ouvert) setMenu(null)
          }}
        />
      )}
    </div>
  )
}
