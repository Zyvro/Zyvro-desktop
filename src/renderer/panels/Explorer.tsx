import { useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useQueries, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
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
import { ZYVRO_ENTRY, canMove, dropFolder, entriesFromText, parentOf, topmost } from "../../shared/treedrop"
import { clearHeld, heldItem } from "~/state/clipboard"
import { EntryMenu } from "~/panels/EntryMenu"
import { isAbsolutePath } from "../../shared/external"
import { ancestorsOf, clickSelect, dragged, navigate, scrollToShow, typeAhead, TYPE_AHEAD_MS, type Selection } from "../../shared/treenav"
import { renameEntry, trashEntries } from "~/lib/entryActions"
import { useGitStatus } from "~/lib/git"
import { FileTypeIcon } from "~/lib/fileIcons"
import { decorations, type Decoration, type Tone } from "../../shared/gitdecor"

// Les couleurs de git, celles de VS Code en thème sombre, à peu près. Ici et
// pas dans `shared/gitdecor` : Tailwind ne lit que le rendu, et une classe
// écrite ailleurs disparaîtrait du CSS.
const TONE_CLASS: Record<Tone, string> = {
  modified: "text-amber-300",
  added: "text-emerald-300",
  deleted: "text-rose-400",
  conflicted: "text-fuchsia-300",
}

// The file tree loads one directory at a time. Reading the whole project up
// front would be fine for a small folder and unusable for a real repository,
// and the user only ever looks at the branches they open.

function dirKey(path: string) {
  return ["files", "list", path] as const
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

// Ce que l'arbre est en train de faire glisser, relatif à la racine.
//
// Gardé ici parce qu'un survol ne peut pas lire ce qu'il transporte : le
// navigateur ne rend les données qu'au lâcher. Or c'est au survol qu'il faut
// savoir si la destination a un sens — un dossier qu'on survole avec lui-même
// ne doit pas s'allumer.
let enMain: string[] = []

// Combien de temps survoler un dossier replié avant qu'il s'ouvre. Le temps
// qu'il faut pour viser, pas assez pour s'impatienter : c'est ce que fait le
// Finder, et c'est ce qui permet de déposer trois niveaux plus bas sans lâcher.
const OPEN_ON_HOVER_MS = 600

function Row({
  entry,
  depth,
  isOpen,
  isActive,
  isDropTarget,
  isFocused,
  isSelected,
  dragPaths,
  decor,
  folderTone,
  chargement,
  onFocusRow,
  onToggle,
  onOpen,
  onMenu,
  root,
}: {
  entry: DirEntry
  depth: number
  isOpen: boolean
  isActive: boolean
  isDropTarget: boolean
  isFocused: boolean
  /** Dans la sélection multiple. */
  isSelected: boolean
  /** Ce que la ligne emporte si on l'attrape : la sélection, ou elle seule. */
  dragPaths: string[]
  /** Ce que git dit de ce fichier, s'il dit quelque chose. */
  decor?: Decoration
  /** La couleur la plus grave de ce que contient ce dossier. */
  folderTone?: Tone
  chargement: boolean
  onFocusRow: (path: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => boolean
  onToggle: (path: string) => void
  onOpen: (path: string) => void
  onMenu: (entry: DirEntry, at: { x: number; y: number }) => void
  root: string | null
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[13px] leading-5",
        isDropTarget
          ? "bg-sky-400/[0.18] text-foreground ring-1 ring-inset ring-sky-400/50"
          : isSelected
            ? "bg-sky-400/[0.12] text-foreground"
            : isActive
            ? "bg-white/[0.08] text-foreground"
            : "text-foreground/80 hover:bg-white/[0.05]",
        // La ligne que le clavier tient. Un liseré plutôt qu'un fond : le
        // fond dit déjà « fichier ouvert », et les deux peuvent différer.
        isFocused && "ring-1 ring-inset ring-sky-400/40"
      )}
      // Hors de l'ordre de tabulation : c'est l'arbre entier qui prend le
      // focus, et les flèches qui choisissent la ligne.
      tabIndex={-1}
      // Lues par l'arbre au survol et au lâcher : un seul écouteur pour toutes
      // les lignes, comme le menu contextuel.
      data-entry-path={entry.path}
      data-entry-kind={entry.kind}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={(event) => {
        // ⌘-clic et ⇧-clic composent une sélection ; seul le clic simple ouvre.
        if (!onFocusRow(entry.path, event)) return
        if (entry.kind === "directory") onToggle(entry.path)
        else onOpen(entry.path)
      }}
      // Double-clic : ouvrir et garder, comme dans VS Code. Le premier clic a
      // déjà ouvert l'aperçu ; le second l'épingle.
      onDoubleClick={() => {
        if (entry.kind === "file") useWorkspace.getState().pinTab(`file:${entry.path}`)
      }}
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
        // Un chemin par ligne : la sélection entière voyage, vers un autre
        // dossier, vers le chat ou vers le terminal.
        const absolus = dragPaths.map((p) => `${root.replace(/\/$/, "")}/${p}`).join("\n")
        // Notre type dit « ceci est un fichier désigné » ; le `text/plain`
        // qui l'accompagne est ce que toute autre application comprendra.
        event.dataTransfer.setData(ZYVRO_PATH, absolus)
        event.dataTransfer.setData("text/plain", absolus)
        // Le chemin relatif, pour l'arbre lui-même : lâchée sur un dossier, la
        // ligne y est déplacée.
        event.dataTransfer.setData(ZYVRO_ENTRY, dragPaths.join("\n"))
        event.dataTransfer.effectAllowed = "copyMove"
        enMain = dragPaths
      }}
      onDragEnd={() => {
        enMain = []
      }}
    >
      {/* Le chevron, ou sa place : un fichier s'aligne sur le dossier voisin,
          comme dans VS Code, et les icônes font une colonne. */}
      {entry.kind === "directory" ? (
        isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="h-3.5 w-3.5 shrink-0" />
      )}
      <FileTypeIcon name={entry.name} folder={entry.kind === "directory"} open={isOpen} />
      <span className={cn("truncate", decor ? TONE_CLASS[decor.tone] : folderTone && TONE_CLASS[folderTone])}>
        {entry.name}
      </span>
      {decor && (
        <span className={cn("ml-auto shrink-0 pl-2 font-mono text-[11px]", TONE_CLASS[decor.tone])}>
          {decor.letter}
        </span>
      )}
      {!decor && folderTone && !chargement && (
        <span className={cn("ml-auto shrink-0 pl-2 text-[10px]", TONE_CLASS[folderTone])}>●</span>
      )}
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

  // Le dossier où irait ce qu'on survole, "" pour la racine, null hors dépôt.
  const [cible, setCible] = useState<string | null>(null)
  // Ce qui a mal tourné au dernier dépôt, dit sous l'en-tête plutôt qu'avalé.
  const [erreurDepot, setErreurDepot] = useState("")
  const survol = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)

  // La ligne que tient le clavier, et le cadre qui défile — pour y ramener la
  // ligne quand les flèches la font sortir de vue.
  const [focus, setFocus] = useState<string | null>(null)
  const cadre = useRef<HTMLDivElement | null>(null)
  // Un chemin à amener dans le cadre dès que sa ligne existe : ses dossiers
  // parents se déplient d'abord, et leur contenu arrive après.
  const aMontrer = useRef<string | null>(null)

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

  // Déplier sans replier : c'est ce que veut un dépôt, qui doit montrer ce
  // qu'il vient d'écrire, et un survol, qui ouvre le dossier qu'on vise.
  const deplier = (path: string): void => {
    if (path === "") return
    setExpanded((current) => {
      if (current.has(path)) return current
      watchDir(path)
      return new Set(current).add(path)
    })
  }

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

  // Git, dans l'arbre. La même requête que le panneau Git et la barre d'état —
  // même clé, donc un seul `git status` pour les trois.
  const git = useGitStatus(Boolean(project))
  const deco = useMemo(() => {
    const g = git.data
    if (!g || !g.repository) return null
    return decorations([...g.conflicts, ...g.staged, ...g.unstaged], g.projectPrefix ?? "")
  }, [git.data])
  const racine = listes[0]

  // Ce qu'on voit du défilement. Deux nombres, et ils suffisent : la hauteur
  // d'une ligne est fixe, donc la première ligne visible est une division.
  const [scrollTop, setScrollTop] = useState(0)
  const [hauteur, setHauteur] = useState(600)
  const mesurer = (node: HTMLDivElement | null): void => {
    cadre.current = node
    if (node) setHauteur(node.clientHeight || 600)
  }

  // Amener une ligne dans le cadre. L'arbre est virtualisé : la ligne visée
  // n'existe peut-être pas encore dans le DOM, donc on défile par le calcul,
  // pas par `scrollIntoView`.
  const montrer = (path: string): boolean => {
    const index = lignes.findIndex((l) => l.entry.path === path)
    const node = cadre.current
    if (index < 0 || !node) return false
    const cible = scrollToShow(index, ROW_HEIGHT, node.scrollTop, node.clientHeight || hauteur)
    if (cible !== null) node.scrollTop = cible
    return true
  }
  if (aMontrer.current) {
    const chemin = aMontrer.current
    // Après le rendu : défiler est un effet sur le DOM, pas un calcul.
    window.queueMicrotask(() => {
      if (aMontrer.current === chemin && montrer(chemin)) aMontrer.current = null
    })
  }

  // Révéler le fichier actif, comme VS Code : ouvrir un fichier par ⌘P, par la
  // recherche ou par l'agent déplie l'arbre jusqu'à lui et le montre. Décidé
  // pendant le rendu, en comparant à ce qu'on a déjà révélé — c'est la forme
  // que prend ici ce que d'autres écriraient dans un effet.
  // Un fichier hors du projet (chemin absolu) n'est pas dans l'arbre.
  const actif = activeTabId.startsWith("file:") && !isAbsolutePath(activeTabId.slice(5)) ? activeTabId.slice(5) : null
  const [revele, setRevele] = useState<string | null>(null)
  if (project && actif !== revele) {
    setRevele(actif)
    if (actif) {
      const manquants = ancestorsOf(actif).filter((d) => !expanded.has(d))
      if (manquants.length > 0) {
        setExpanded((current) => {
          const next = new Set(current)
          for (const d of manquants) {
            if (!next.has(d)) {
              next.add(d)
              watchDir(d)
            }
          }
          return next
        })
      }
      setFocus(actif)
      aMontrer.current = actif
    }
  }

  // La sélection multiple : ⌘-clic (Ctrl-clic ailleurs) et ⇧-clic. Rend vrai
  // quand le clic doit aussi ouvrir, c'est-à-dire pour un clic simple.
  const [selection, setSelection] = useState<Selection>({ paths: new Set(), anchor: null })
  const prendreLeFocus = (path: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean => {
    setFocus(path)
    const mac = window.zyvro.platform === "darwin"
    const r = clickSelect(selection, path, lignes.map((l) => ({ path: l.entry.path })), {
      toggle: mac ? event.metaKey : event.ctrlKey,
      range: event.shiftKey,
    })
    setSelection({ paths: r.paths, anchor: r.anchor })
    // Le bouton cliqué rend la main à l'arbre : il peut disparaître au
    // prochain défilement, et le clavier avec lui.
    cadre.current?.focus({ preventScroll: true })
    return r.act
  }

  // Ce qu'on a tapé à la suite, pour taper-pour-chercher.
  const frappe = useRef({ typed: "", at: 0 })

  const toutReplier = (): void => {
    setExpanded((current) => {
      for (const d of current) unwatchDir(d)
      return new Set()
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (menu) return
    const entree = focus ? lignes.find((l) => l.entry.path === focus)?.entry : undefined
    if (entree && event.key === "F2") {
      event.preventDefault()
      void renameEntry(entree, client)
      return
    }
    // Suppr, et ⌘⌫ sur un Mac, dont le clavier n'a souvent pas de Suppr. Toute
    // la sélection quand la ligne tenue en fait partie.
    if (entree && (event.key === "Delete" || (event.key === "Backspace" && event.metaKey))) {
      event.preventDefault()
      const chemins = dragged(selection.paths, entree.path)
      const entrees = lignes.filter((l) => chemins.includes(l.entry.path)).map((l) => l.entry)
      void trashEntries(entrees, client).then((fait) => {
        if (fait) setSelection({ paths: new Set(), anchor: null })
      })
      return
    }
    // Échap vide la sélection, comme partout.
    if (event.key === "Escape" && selection.paths.size > 1) {
      setSelection({ paths: new Set(focus ? [focus] : []), anchor: focus })
      return
    }
    const rows = lignes.map((l) => ({ path: l.entry.path, kind: l.entry.kind, depth: l.depth }))
    // Taper pour chercher : un caractère imprimable, sans modificateur, saute à
    // la ligne dont le nom commence par ce qu'on tape (`typeAhead`).
    if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const maintenant = Date.now()
      const tape = maintenant - frappe.current.at < TYPE_AHEAD_MS ? frappe.current.typed + event.key : event.key
      frappe.current = { typed: tape, at: maintenant }
      const vers = typeAhead(rows, focus, tape)
      event.preventDefault()
      if (vers) {
        setFocus(vers)
        setSelection({ paths: new Set([vers]), anchor: vers })
        montrer(vers)
      }
      return
    }
    const r = navigate(rows, focus, event.key, expanded)
    if (Object.keys(r).length === 0) return
    event.preventDefault()
    if (r.expand) deplier(r.expand)
    if (r.collapse) toggle(r.collapse)
    if (r.open) openFile(r.open)
    if (r.focus) {
      setFocus(r.focus)
      montrer(r.focus)
    }
  }

  if (!project) {
    // `flex-1` : la place vide appartient à l'arbre absent, pas aux sections
    // d'en dessous. Sans ça, les listes — shells persistants, workflows —
    // remontaient se coller sous cette phrase au lieu de rester en bas de la
    // barre, où elles sont dès qu'un projet est ouvert. Signalé par Jeremy :
    // « ça doit être collé en bas, c'est listé, pas remonté en haut ».
    return <p className="flex-1 px-3 py-2 text-[13px] text-muted-foreground">No project open.</p>
  }

  const premiere = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const derniere = Math.min(lignes.length, Math.ceil((scrollTop + hauteur) / ROW_HEIGHT) + OVERSCAN)
  const visibles = lignes.slice(premiere, derniere)

  // ---- déposer sur l'arbre ----------------------------------------------
  //
  // Deux sources. Une ligne de l'arbre porte ZYVRO_ENTRY : elle est déplacée,
  // ou copiée si l'on tient Alt. Un fichier du Finder porte « Files » : il est
  // copié dans le projet, jamais retiré du bureau. Tout le reste — du texte
  // glissé d'une page — n'est pas pour l'arbre, et le survol n'est pas
  // intercepté.

  const viseSur = (event: React.DragEvent): { path: string; kind: "file" | "directory" } | null => {
    const ligne = (event.target as HTMLElement).closest<HTMLElement>("[data-entry-path]")
    if (!ligne) return null
    const kind = ligne.dataset.entryKind === "directory" ? "directory" : "file"
    return { path: ligne.dataset.entryPath ?? "", kind }
  }

  const sourceDe = (event: React.DragEvent): "tree" | "os" | null => {
    const types = [...event.dataTransfer.types]
    if (types.includes(ZYVRO_ENTRY)) return "tree"
    if (types.includes("Files")) return "os"
    return null
  }

  const oublierSurvol = (): void => {
    if (survol.current) clearTimeout(survol.current.timer)
    survol.current = null
  }

  const onDragOver = (event: React.DragEvent): void => {
    const source = sourceDe(event)
    if (!source) return
    const vise = viseSur(event)
    const dossier = dropFolder(vise)
    const mode = event.altKey ? "copy" : "move"
    if (source === "tree" && enMain.length > 0 && !enMain.every((from) => canMove(from, dossier, mode))) {
      // Pas de `preventDefault` : le curseur dit « interdit », et c'est vrai.
      setCible(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = source === "os" || mode === "copy" ? "copy" : "move"
    setCible(dossier)

    // Un dossier replié qu'on survole s'ouvre après un instant.
    if (vise?.kind === "directory" && !expanded.has(vise.path)) {
      if (survol.current?.path !== vise.path) {
        oublierSurvol()
        const path = vise.path
        survol.current = { path, timer: setTimeout(() => deplier(path), OPEN_ON_HOVER_MS) }
      }
    } else {
      oublierSurvol()
    }
  }

  const onDragLeave = (event: React.DragEvent): void => {
    // Quitter une ligne pour sa voisine déclenche aussi un `dragleave` ; seul
    // compte celui qui sort de l'arbre entier.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setCible(null)
    oublierSurvol()
  }

  const relireDossier = (chemin: string): Promise<void> =>
    client.invalidateQueries({ queryKey: dirKey(chemin || ".") })

  const onDrop = async (event: React.DragEvent): Promise<void> => {
    const source = sourceDe(event)
    if (!source) return
    event.preventDefault()
    const dossier = dropFolder(viseSur(event))
    setCible(null)
    oublierSurvol()
    setErreurDepot("")

    try {
      if (source === "os") {
        const fichiers = [...event.dataTransfer.files]
        if (fichiers.length === 0) return
        await window.zyvro.files.importDropped(fichiers, dossier)
        await relireDossier(dossier)
        deplier(dossier)
        return
      }

      const mode = event.altKey ? "copy" : "move"
      const chemins = topmost(entriesFromText(event.dataTransfer.getData(ZYVRO_ENTRY)))
      enMain = []
      const touches = new Set<string>([dossier])
      for (const from of chemins) {
        if (!canMove(from, dossier, mode)) continue
        const ecrit = await window.zyvro.files.paste(from, dossier, mode)
        if (mode === "move") {
          useWorkspace.getState().movePath(from, ecrit)
          touches.add(parentOf(from))
          // Ce qui était coupé et vient de partir ailleurs ne se colle plus.
          const garde = heldItem()
          if (garde && (garde.path === from || garde.path.startsWith(`${from}/`))) clearHeld()
        }
      }
      await Promise.all([...touches].map(relireDossier))
      deplier(dossier)
    } catch (err) {
      setErreurDepot((err as Error).message)
      void client.invalidateQueries({ queryKey: ["files", "list"] })
    }
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
          title="Collapse Folders"
          onClick={toutReplier}
        >
          <ChevronsDownUp className="h-3.5 w-3.5" />
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
      {erreurDepot && (
        <button
          className="mx-2 mb-1 rounded bg-destructive/15 px-2 py-1 text-left text-[12px] text-destructive"
          title="Dismiss"
          onClick={() => setErreurDepot("")}
        >
          {erreurDepot}
        </button>
      )}

      <div
        ref={mesurer}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(event) => void onDrop(event)}
        className={cn(
          "zy-scroll min-h-0 flex-1 overflow-y-auto pb-2 pr-1 outline-none",
          // La racine n'a pas de ligne à allumer : c'est l'arbre entier qui
          // dit « ici ».
          cible === "" && "rounded-md ring-1 ring-inset ring-sky-400/50 bg-sky-400/[0.06]"
        )}
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
              isDropTarget={cible !== null && cible !== "" && entry.path === cible}
              isFocused={focus === entry.path}
              isSelected={selection.paths.size > 1 && selection.paths.has(entry.path)}
              dragPaths={dragged(selection.paths, entry.path)}
              decor={deco?.files.get(entry.path)}
              folderTone={entry.kind === "directory" ? deco?.folders.get(entry.path) : undefined}
              onFocusRow={prendreLeFocus}
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
