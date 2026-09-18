import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { EntryMenu, useEntryMenu } from "~/panels/EntryMenu"

// The file tree loads one directory at a time. Reading the whole project up
// front would be fine for a small folder and unusable for a real repository,
// and the user only ever looks at the branches they open.

function dirKey(path: string) {
  return ["files", "list", path] as const
}

function useDir(path: string, enabled: boolean) {
  // La version du dossier fait partie de la clé : quand le disque bouge, c'est
  // une requête nouvelle, et react-query va la chercher sans que personne
  // n'invalide quoi que ce soit.
  const version = useSyncExternalStore(
    subscribeFiles,
    () => versionOf(path),
    () => 0
  )
  return useQuery({
    queryKey: [...dirKey(path), version],
    queryFn: () => window.zyvro.files.list(path),
    enabled,
    staleTime: 5000,
  })
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

type RowProps = {
  entry: DirEntry
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  /** La racine du projet : l'arbre parle en relatif, un chemin déposé ailleurs
   *  doit être absolu — il part vers un shell ou vers un agent, et ni l'un ni
   *  l'autre ne sait d'où il est compté. */
  root: string | null
}

function Row({ entry, depth, expanded, onToggle, root }: RowProps) {
  const openFile = useWorkspace((s) => s.openFile)
  // Le clic droit sur cette ligne. Son état vit ici — une ligne par menu —
  // parce qu'un menu partagé par tout l'arbre devrait retenir sur QUELLE ligne
  // on a cliqué, ce qui est une deuxième vérité à côté de celle-ci.
  const menu = useEntryMenu()
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const isOpen = expanded.has(entry.path)
  const isActive = activeTabId === `file:${entry.path}`
  const children = useDir(entry.path, entry.kind === "directory" && isOpen)

  return (
    <>
      <button
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] leading-5",
          isActive ? "bg-white/[0.08] text-foreground" : "text-foreground/80 hover:bg-white/[0.05]"
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (entry.kind === "directory" ? onToggle(entry.path) : openFile(entry.path))}
        title={entry.path}
        onContextMenu={menu.onContextMenu}
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
        {children.isFetching && <Loader2 className="ml-auto h-3 w-3 shrink-0 zy-spin opacity-60" />}
      </button>

      <EntryMenu entry={entry} root={root} open={menu.open} at={menu.at} onOpenChange={menu.onOpenChange} />

      {entry.kind === "directory" &&
        isOpen &&
        (children.data ?? []).map((child) => (
          <Row key={child.path} entry={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} root={root} />
        ))}
    </>
  )
}

export function Explorer() {
  const project = useWorkspace((s) => s.project)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const client = useQueryClient()
  const root = useDir(".", Boolean(project))

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

  if (!project) {
    return <p className="px-3 py-2 text-[13px] text-muted-foreground">No project open.</p>
  }

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
          <RefreshCw className={cn("h-3.5 w-3.5", root.isFetching && "zy-spin")} />
        </button>
      </header>

      <div className="zy-scroll min-h-0 flex-1 overflow-y-auto pb-2 pr-1">
        {root.isError && (
          <p className="px-3 py-2 text-[13px] text-destructive">{(root.error as Error).message}</p>
        )}
        {(root.data ?? []).map((entry) => (
          <Row key={entry.path} entry={entry} depth={0} expanded={expanded} onToggle={toggle} root={project.project} />
        ))}
      </div>
    </div>
  )
}
