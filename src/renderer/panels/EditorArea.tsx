import { useCallback, useRef, useState } from "react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace, type Tab } from "~/state/workspace"
import { requestCloseTab, requestCloseTabs, tabsToClose } from "~/lib/closing"
import { FileTypeIcon } from "~/lib/fileIcons"
import { isAbsolutePath, nativePath } from "../../shared/external"
import { CodeEditor } from "./CodeEditor"
import { GraphTab } from "./GraphTab"
import { DiffView } from "./DiffView"
import { GitOutput } from "./GitOutput"
import { Welcome } from "./Welcome"
import { ProvidersTab } from "./ProvidersTab"
import { SettingsTab } from "./SettingsTab"
import { PreviewTab } from "./PreviewTab"
import { ProblemsTab } from "./ProblemsTab"
import { StorePanel } from "./StorePanel"
import { BrowserTab } from "./BrowserTab"
import { Favicon } from "./BrowserList"

// Every open tab stays mounted. A graph that unmounted when you glanced at a
// file would lose its viewport, its selection and any run in progress, so tabs
// are hidden rather than destroyed, and only the active one is visible.

// Le type que pose un onglet qu'on attrape : son identifiant, pour le reposer
// ailleurs dans la barre.
const ZYVRO_TAB = "application/x-zyvro-tab"

function TabButton({
  tab,
  active,
  onMenu,
  dropBefore,
  onDropHover,
  onDropDone,
  onActivate,
  onCloseTab,
}: {
  tab: Tab
  active: boolean
  onMenu: (tabId: string, at: { x: number; y: number }) => void
  /** Le groupe de droite active et ferme sa vue, pas l'onglet (voir `split`). */
  onActivate?: (tabId: string) => void
  onCloseTab?: (tabId: string) => void
  /** Un onglet va se poser juste avant celui-ci. */
  dropBefore: boolean
  onDropHover: (beforeId: string | null | undefined) => void
  onDropDone: (draggedId: string) => void
}) {
  const activateTab = useWorkspace((s) => s.activateTab)
  const dirty = useWorkspace((s) => tab.id in s.drafts)
  // Un aperçu : un fichier regardé, jamais modifié ni épinglé, que le prochain
  // fichier ouvert remplacera. En italique, comme dans VS Code — sans ce signe,
  // voir son onglet disparaître a l'air d'un défaut.
  const apercu = tab.kind === "file" && !tab.pinned && !dirty

  // A callback ref rather than an effect, per DOCTRINE-SANS-USEEFFECT: the
  // identity changes with `active`, so React runs it exactly when this tab
  // becomes the active one. Opening a file when the bar is already full would
  // otherwise put its tab somewhere off to the right, out of sight.
  const reveal = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && active) el.scrollIntoView({ block: "nearest", inline: "nearest" })
    },
    [active]
  )

  return (
    <div
      ref={reveal}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(tab.id, { x: event.clientX, y: event.clientY })
      }}
      // Glisser un onglet le déplace dans la barre. Posé avant l'onglet survolé
      // quand on vise sa moitié gauche, après quand on vise la droite.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ZYVRO_TAB, tab.id)
        event.dataTransfer.effectAllowed = "move"
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes(ZYVRO_TAB)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        const box = event.currentTarget.getBoundingClientRect()
        const avant = event.clientX < box.left + box.width / 2
        const tabs = useWorkspace.getState().tabs
        const i = tabs.findIndex((t) => t.id === tab.id)
        onDropHover(avant ? tab.id : (tabs[i + 1]?.id ?? null))
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(ZYVRO_TAB)
        if (!id) return
        event.preventDefault()
        onDropDone(id)
      }}
      onDragEnd={() => onDropHover(undefined)}
      onDoubleClick={() => useWorkspace.getState().pinTab(tab.id)}
      // Le clic du milieu ferme, comme dans un navigateur et dans VS Code.
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        if (onCloseTab) onCloseTab(tab.id)
        else void requestCloseTab(tab.id)
      }}
      className={cn(
        "group flex h-9 max-w-[220px] shrink-0 items-center gap-2 border-r border-white/[0.06] pl-3 pr-2 text-[13px]",
        // Où l'onglet qu'on tient va se poser.
        dropBefore && "shadow-[inset_2px_0_0_0_rgb(56_189_248)]",
        active
          ? "bg-background text-foreground"
          : "bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05]"
      )}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
        // Un fichier hors du projet dit d'où il vient.
        title={tab.kind === "file" && isAbsolutePath(tab.path) ? nativePath(tab.path, window.zyvro.platform) : undefined}
        onClick={() => (onActivate ?? activateTab)(tab.id)}
      >
        {/* Une page porte son favicon, un fichier l'icône de son type — la même
            que dans l'arbre, pour qu'on reconnaisse l'un dans l'autre. */}
        {tab.kind === "browser" && <Favicon key={tab.icon} icon={tab.icon} className="h-3.5 w-3.5" />}
        {(tab.kind === "file" || tab.kind === "diff" || tab.kind === "preview") && (
          <FileTypeIcon name={tab.path.slice(tab.path.lastIndexOf("/") + 1)} className="h-3.5 w-3.5" />
        )}
        <span className={cn("truncate", apercu && "italic")}>{tab.title}</span>
      </button>
      <button
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
        title="Close"
        onClick={() => (onCloseTab ? onCloseTab(tab.id) : void requestCloseTab(tab.id))}
      >
        {dirty ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary group-hover:hidden" />
        ) : null}
        <X className={cn("h-3 w-3", dirty && "hidden group-hover:block")} />
      </button>
    </div>
  )
}

function TabBody({ tab, group = "main" }: { tab: Tab; group?: "main" | "split" }) {
  switch (tab.kind) {
    case "file":
      return <CodeEditor tabId={tab.id} path={tab.path} group={group} />
    case "graph":
      return <GraphTab workflowId={tab.workflowId} />
    case "diff":
      return <DiffView path={tab.path} staged={tab.staged} />
    case "gitOutput":
      return <GitOutput />
    case "providers":
      return <ProvidersTab />
    case "settings":
      return <SettingsTab />
    case "preview":
      return <PreviewTab path={tab.path} />
    case "problems":
      return <ProblemsTab />
    case "store":
      return <StorePanel />
    case "browser":
      return <BrowserTab tabId={tab.id} url={tab.url} />
    default:
      return <Welcome />
  }
}

const itemMenu =
  "flex cursor-default select-none items-center justify-between gap-6 rounded px-2 py-1 text-[12px] outline-none data-[highlighted]:bg-white/[0.09] data-[disabled]:opacity-40"

// Le clic droit sur un onglet : ce que VS Code y propose et que cette
// application sait faire. Un seul menu pour toute la barre, ancré au curseur.
function TabMenu({
  tabId,
  at,
  onClose,
}: {
  tabId: string
  at: { x: number; y: number }
  onClose: () => void
}) {
  const tabs = useWorkspace((s) => s.tabs)
  const root = useWorkspace((s) => s.project?.project ?? null)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return null
  const ids = tabs.map((t) => t.id)
  const puis = (action: () => void | Promise<unknown>) => () => {
    onClose()
    void action()
  }
  const chemin = tab.kind === "file" || tab.kind === "diff" || tab.kind === "preview" ? tab.path : null
  // Le chemin absolu s'écrit avec les séparateurs du système : c'est ce qu'on
  // colle ensuite dans un shell ou dans l'Explorateur Windows.
  const sep = window.zyvro.platform === "win32" ? "\\" : "/"
  const dehors = chemin !== null && isAbsolutePath(chemin)
  const absolu = dehors
    ? nativePath(chemin, window.zyvro.platform)
    : chemin && root ? `${root.replace(/[\\/]$/, "")}${sep}${chemin.split("/").join(sep)}` : null
  const revelerDans = window.zyvro.platform === "darwin" ? "Reveal in Finder" : "Reveal in File Explorer"
  return (
    <Menu.Root open onOpenChange={(open) => !open && onClose()}>
      <Menu.Trigger asChild>
        <span className="pointer-events-none fixed h-0 w-0" style={{ left: at.x, top: at.y }} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="panel z-50 min-w-[200px] p-1" align="start" sideOffset={0}>
          <Menu.Item className={itemMenu} onSelect={puis(() => requestCloseTab(tabId))}>
            Close
          </Menu.Item>
          <Menu.Item
            className={itemMenu}
            disabled={ids.length < 2}
            onSelect={puis(() => requestCloseTabs(tabsToClose(ids, tabId, "others")))}
          >
            Close Others
          </Menu.Item>
          <Menu.Item
            className={itemMenu}
            disabled={ids.indexOf(tabId) === ids.length - 1}
            onSelect={puis(() => requestCloseTabs(tabsToClose(ids, tabId, "right")))}
          >
            Close to the Right
          </Menu.Item>
          <Menu.Item className={itemMenu} onSelect={puis(() => requestCloseTabs(tabsToClose(ids, tabId, "all")))}>
            Close All
          </Menu.Item>
          {chemin && (
            <>
              <Menu.Separator className="my-1 h-px bg-white/[0.08]" />
              {absolu && (
                <Menu.Item className={itemMenu} onSelect={puis(() => navigator.clipboard.writeText(absolu))}>
                  Copy Path
                </Menu.Item>
              )}
              {!dehors && (
                <Menu.Item className={itemMenu} onSelect={puis(() => navigator.clipboard.writeText(chemin))}>
                  Copy Relative Path
                </Menu.Item>
              )}
              <Menu.Item className={itemMenu} onSelect={puis(() => window.zyvro.files.reveal(chemin))}>
                {revelerDans}
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

export function EditorArea() {
  const tabs = useWorkspace((s) => s.tabs)
  const activeTabId = useWorkspace((s) => s.activeTabId)
  const split = useWorkspace((s) => s.split)
  const focusedGroup = useWorkspace((s) => s.focusedGroup)
  const [menu, setMenu] = useState<{ tabId: string; at: { x: number; y: number } } | null>(null)
  // Pendant qu'on déplace un onglet : avant qui il se posera (null : à la
  // fin), ou undefined quand rien ne glisse.
  const [poseAvant, setPoseAvant] = useState<string | null | undefined>(undefined)
  // Un onglet tenu au-dessus de la moitié droite : il s'y ouvrira, comme dans
  // VS Code.
  const [versDroite, setVersDroite] = useState(false)
  // La part de la largeur laissée à gauche quand l'éditeur est partagé.
  const [part, setPart] = useState(0.5)
  const cadre = useRef<HTMLElement | null>(null)

  const tientUnOnglet = (event: React.DragEvent) => [...event.dataTransfer.types].includes(ZYVRO_TAB)
  const aDroite = (event: React.DragEvent) => {
    const r = event.currentTarget.getBoundingClientRect()
    return event.clientX > r.left + r.width / 2
  }

  const principal = (
    <div
      className={cn("flex min-h-0 min-w-0 flex-col", split && focusedGroup === "main" && "zy-group-focused")}
      style={split ? { flexBasis: `${part * 100}%`, flexGrow: 0, flexShrink: 0 } : { flex: 1 }}
      onMouseDownCapture={() => useWorkspace.getState().focusGroup("main")}
    >
      {/* overflow-y is pinned hidden on purpose. Setting overflow-x alone makes
          the browser compute overflow-y as auto, and then the horizontal
          scrollbar eats a few pixels inside a fixed height — so the row of tabs
          became a few pixels too tall for its own box and scrolled vertically,
          carrying the tabs out of view. */}
      {/* No tab row when there is nothing in it: an empty strip above an empty
          area is a piece of furniture standing where the work goes. */}
      <div
        className="zy-tabs flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-white/[0.06] bg-white/[0.015]"
        hidden={tabs.length === 0}
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onMenu={(tabId, at) => setMenu({ tabId, at })}
            dropBefore={poseAvant === tab.id}
            onDropHover={setPoseAvant}
            onDropDone={(dragged) => {
              if (poseAvant !== undefined) useWorkspace.getState().moveTab(dragged, poseAvant)
              setPoseAvant(undefined)
            }}
          />
        ))}
      </div>

      <div
        className="relative min-h-0 flex-1"
        // Sans groupe de droite, lâcher un onglet sur la moitié droite l'y
        // ouvre.
        //
        // Avec un groupe à droite, un de ses onglets lâché ici revient à
        // gauche : sa vue de droite se ferme, il devient l'onglet actif.
        onDragOver={(event) => {
          if (!tientUnOnglet(event)) return
          event.preventDefault()
          if (!split) setVersDroite(aDroite(event))
        }}
        onDragLeave={() => setVersDroite(false)}
        onDrop={(event) => {
          if (!tientUnOnglet(event)) return
          event.preventDefault()
          setVersDroite(false)
          const id = event.dataTransfer.getData(ZYVRO_TAB)
          const store = useWorkspace.getState()
          if (split) {
            if (!split.ids.includes(id)) return
            store.closeInSplit(id)
            store.activateTab(id)
            return
          }
          if (aDroite(event)) store.splitEditor(id)
        }}
      >
        {tabs.map((tab) => (
          <div key={tab.id} className="absolute inset-0" hidden={tab.id !== activeTabId}>
            <TabBody tab={tab} />
          </div>
        ))}
        {versDroite && <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-sky-400/10 ring-1 ring-inset ring-sky-400/40" />}
      </div>
    </div>
  )

  return (
    <section ref={cadre} className="flex min-h-0 min-w-0 flex-1 flex-row">
      {principal}
      {split && (
        <>
          {/* La séparation se tire, comme dans VS Code ; entre 20 % et 80 %. */}
          <div
            className="w-1 shrink-0 cursor-col-resize bg-white/[0.06] hover:bg-sky-400/40"
            onPointerDown={(event) => {
              const el = cadre.current
              if (!el) return
              event.currentTarget.setPointerCapture(event.pointerId)
              const r = el.getBoundingClientRect()
              const bouger = (e: PointerEvent) => setPart(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)))
              const lacher = () => {
                window.removeEventListener("pointermove", bouger)
                window.removeEventListener("pointerup", lacher)
              }
              window.addEventListener("pointermove", bouger)
              window.addEventListener("pointerup", lacher)
            }}
            onDoubleClick={() => setPart(0.5)}
          />
          <SplitGroup split={split} focused={focusedGroup === "split"} tabs={tabs} />
        </>
      )}
      {menu && <TabMenu key={`${menu.tabId}:${menu.at.x}:${menu.at.y}`} {...menu} onClose={() => setMenu(null)} />}
    </section>
  )
}

// Le groupe de droite : ses onglets, pris dans la liste, et leur contenu —
// monté comme à gauche, un éditeur de plus sur le même document.
function SplitGroup({ split, focused, tabs }: { split: { ids: string[]; active: string }; focused: boolean; tabs: Tab[] }) {
  const parId = new Map(tabs.map((t) => [t.id, t]))
  const montres = split.ids.map((id) => parId.get(id)).filter((t): t is Tab => Boolean(t))
  const store = useWorkspace.getState
  return (
    <div
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", focused && "zy-group-focused")}
      onMouseDownCapture={() => store().focusGroup("split")}
      // Un onglet de gauche lâché ici s'y montre aussi.
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes(ZYVRO_TAB)) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        const id = event.dataTransfer.getData(ZYVRO_TAB)
        if (!id) return
        event.preventDefault()
        store().splitEditor(id)
      }}
    >
      <div className="zy-tabs flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-white/[0.06] bg-white/[0.015]">
        {montres.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === split.active}
            onMenu={() => undefined}
            dropBefore={false}
            onDropHover={() => undefined}
            onDropDone={() => undefined}
            onActivate={(id) => store().activateInSplit(id)}
            onCloseTab={(id) => store().closeInSplit(id)}
          />
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        {montres.map((tab) => (
          <div key={tab.id} className="absolute inset-0" hidden={tab.id !== split.active}>
            <TabBody tab={tab} group="split" />
          </div>
        ))}
      </div>
    </div>
  )
}
