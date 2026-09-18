import { useState, type ReactNode } from "react"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { useQueryClient } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import type { DirEntry } from "../../preload"
import { askConfirm, askName } from "~/state/prompt"
import { handTo } from "~/state/handoff"
import { quotePath } from "../../shared/dropped"
import { useWorkspace } from "~/state/workspace"

// Le clic droit sur un fichier ou un dossier.
//
// Ce qu'il propose est ce que cette application sait faire, pas ce que la
// capture d'un autre éditeur montrait. « Open to the Side » demande des
// éditeurs côte à côte, « Select for Compare » un comparateur, « Open Timeline »
// un historique par fichier : trois choses qui n'existent pas ici, et un menu
// qui les propose quand même est un menu dont la moitié déçoit.
//
// Dessiné dans la fenêtre plutôt qu'en menu natif, comme les autres menus de
// l'application. Les deux étaient possibles : vérifié qu'un `preventDefault`
// sur l'événement du rendu empêche bien Electron d'ouvrir le sien, donc il n'y
// a pas deux menus qui se superposent.

const item =
  "flex cursor-default select-none items-center justify-between gap-6 rounded px-2 py-1 text-[12px] outline-none data-[highlighted]:bg-white/[0.09] data-[disabled]:opacity-40"

function Raccourci({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[10px] text-muted-foreground/70">{children}</span>
}

export function EntryMenu({
  entry,
  root,
  open,
  at,
  onOpenChange,
}: {
  entry: DirEntry
  /** La racine du projet. L'arbre parle en relatif ; ce qui sort d'ici — un
   *  chemin copié, un `cd`, un chemin donné à l'agent — doit être absolu. */
  root: string | null
  open: boolean
  /** Là où on a cliqué : un menu contextuel s'ouvre sous le curseur, pas sous
   *  un bouton. */
  at: { x: number; y: number }
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const client = useQueryClient()
  const openFile = useWorkspace((s) => s.openFile)
  const dossier = entry.kind === "directory"
  const absolu = root ? `${root.replace(/\/$/, "")}/${entry.path}` : entry.path
  const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ""

  // Relire le dossier qui contient ce qu'on vient de changer. L'arbre relit par
  // sa version ; ici on invalide, parce que c'est nous qui avons bougé le
  // disque et qu'attendre l'observateur ferait clignoter un nom qui n'existe
  // plus.
  const relire = (chemin: string): void => {
    void client.invalidateQueries({ queryKey: ["files", "list", chemin || "."] })
  }

  const fermerPuis = (action: () => void | Promise<void>) => () => {
    onOpenChange(false)
    void action()
  }

  const creer = async (kind: "file" | "directory") => {
    const nom = await askName({
      title: kind === "file" ? "New file" : "New folder",
      label: `Inside ${entry.path}`,
      confirmLabel: "Create",
    })
    const propre = nom?.trim()
    if (!propre) return
    await window.zyvro.files.create(`${entry.path}/${propre}`, kind)
    relire(entry.path)
    if (kind === "file") openFile(`${entry.path}/${propre}`)
  }

  const renommer = async () => {
    const nom = await askName({
      title: "Rename",
      label: entry.path,
      confirmLabel: "Rename",
      initial: entry.name,
    })
    const propre = nom?.trim()
    if (!propre || propre === entry.name) return
    await window.zyvro.files.rename(entry.path, parent ? `${parent}/${propre}` : propre)
    relire(parent)
  }

  // Supprimer demande, et ce qui part va à la corbeille.
  //
  // Les deux ensemble, parce qu'aucun des deux ne suffit : une confirmation
  // seule fait dire oui à ce qu'on croit avoir visé, et une corbeille seule
  // laisse un dossier disparaître d'un clic. La question nomme le chemin
  // entier, pas seulement le fichier — c'est la seule façon de voir qu'on
  // s'est trompé de ligne.
  const supprimer = async () => {
    const oui = await askConfirm({
      title: dossier ? `Delete the folder ${entry.name}?` : `Delete ${entry.name}?`,
      label: dossier
        ? `${entry.path} and everything inside it moves to the trash.`
        : `${entry.path} moves to the trash.`,
      confirmLabel: "Move to trash",
    })
    if (!oui) return
    await window.zyvro.files.remove(entry.path)
    relire(parent)
  }

  const copier = (texte: string) => {
    void navigator.clipboard.writeText(texte)
  }

  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      {/* Une ancre de taille nulle posée là où on a cliqué : Radix ouvre sous
          son déclencheur, et le déclencheur d'un menu contextuel est le
          curseur. */}
      <Menu.Trigger asChild>
        <span className="pointer-events-none fixed h-0 w-0" style={{ left: at.x, top: at.y }} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="panel z-50 min-w-[220px] p-1" align="start" sideOffset={0}>
          {dossier ? (
            <>
              <Menu.Item className={item} onSelect={fermerPuis(() => creer("file"))}>
                New file…
              </Menu.Item>
              <Menu.Item className={item} onSelect={fermerPuis(() => creer("directory"))}>
                New folder…
              </Menu.Item>
            </>
          ) : (
            <Menu.Item className={item} onSelect={fermerPuis(() => openFile(entry.path))}>
              Open
            </Menu.Item>
          )}

          <Menu.Separator className="my-1 h-px bg-white/[0.08]" />

          {/* Le chemin cité comme un dépôt le citerait : c'est le même geste dit
              autrement, et deux façons de citer, c'est une des deux qui se
              trompe le jour où un dossier a un espace. */}
          <Menu.Item
            className={item}
            onSelect={fermerPuis(() => handTo("agent", absolu))}
            data-disabled={root ? undefined : true}
          >
            Add to agent
          </Menu.Item>
          <Menu.Item
            className={item}
            onSelect={fermerPuis(() =>
              handTo("terminal", `cd ${quotePath(dossier ? absolu : absolu.slice(0, absolu.lastIndexOf("/")), window.zyvro.platform)}\n`)
            )}
          >
            Open in terminal
          </Menu.Item>
          <Menu.Item className={item} onSelect={fermerPuis(() => void window.zyvro.files.reveal(entry.path))}>
            Reveal in Finder
          </Menu.Item>

          <Menu.Separator className="my-1 h-px bg-white/[0.08]" />

          <Menu.Item className={item} onSelect={fermerPuis(() => copier(absolu))}>
            Copy path
          </Menu.Item>
          <Menu.Item className={item} onSelect={fermerPuis(() => copier(entry.path))}>
            Copy relative path
          </Menu.Item>

          <Menu.Separator className="my-1 h-px bg-white/[0.08]" />

          <Menu.Item className={item} onSelect={fermerPuis(renommer)}>
            Rename…
          </Menu.Item>
          <Menu.Item
            className={cn(item, "text-red-300 data-[highlighted]:bg-red-500/[0.12]")}
            onSelect={fermerPuis(supprimer)}
          >
            Delete
            <Raccourci>trash</Raccourci>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

// useEntryMenu : l'état d'un menu contextuel, pour une ligne de l'arbre.
//
// Sorti d'ici pour que la ligne reste une ligne : elle sait où on a cliqué et
// rien d'autre.
export function useEntryMenu(): {
  open: boolean
  at: { x: number; y: number }
  onOpenChange: (open: boolean) => void
  onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => void
} {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState({ x: 0, y: 0 })
  return {
    open,
    at,
    onOpenChange: setOpen,
    onContextMenu: (event) => {
      // Sans ça, Electron ouvre le sien par-dessus : vérifié, un
      // `preventDefault` ici suffit à l'en empêcher.
      event.preventDefault()
      setAt({ x: event.clientX, y: event.clientY })
      setOpen(true)
    },
  }
}
