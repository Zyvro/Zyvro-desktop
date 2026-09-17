// Regarder les dossiers qu'on regarde.
//
// L'arbre lit un dossier à la fois et garde ce qu'il a lu. C'est ce qui le rend
// utilisable sur un vrai dépôt, et c'est aussi pourquoi il ment : un fichier
// qu'un agent vient d'écrire, une branche qu'on vient de changer, un `npm i`
// qui passe — rien de tout ça n'apparaît avant qu'on pense à cliquer sur
// « Refresh ». Et on n'y pense pas, parce qu'un arbre de fichiers a l'air d'un
// arbre de fichiers.
//
// Ce module surveille donc, mais seulement ce qui est ouvert. La distinction
// n'est pas une économie de confort : `fs.watch` récursif sur un dépôt avec un
// `node_modules` ouvre des dizaines de milliers de descripteurs sur macOS et
// noie le processus sous des événements que personne ne regarde. Un dossier
// replié n'est pas affiché ; le surveiller serait payer pour une information
// qu'on jette.
//
// Ce qui en sort est volontairement pauvre : « ce dossier a changé », sans
// dire quoi. Le rendu sait relire un dossier — c'est ce qu'il fait déjà — et
// une liste de différences qu'il faudrait appliquer à la main serait une
// seconde source de vérité à côté de celle qui marche.

import { watch, type FSWatcher } from "node:fs"
import path from "node:path"
import { resolveInside } from "./files"

// QUIET est le temps qu'on laisse passer avant de prévenir.
//
// Une seule opération produit plusieurs événements — écrire un fichier en
// déclenche deux ou trois, `git checkout` en déclenche des centaines — et
// prévenir à chaque fois ferait relire le dossier autant de fois. On attend que
// ça se calme.
const QUIET = 120

export type Changed = (relative: string) => void

/** Watcher tient les dossiers ouverts d'une fenêtre. */
export type Watcher = {
  watch(relative: string): Promise<void>
  unwatch(relative: string): void
  /** Ce qui est surveillé, pour les tests et pour le débogage. */
  watched(): string[]
  dispose(): void
}

type Entry = { handle: FSWatcher; timer: ReturnType<typeof setTimeout> | null }

export function createWatcher(root: () => string | null, changed: Changed): Watcher {
  const open = new Map<string, Entry>()

  function stop(key: string): void {
    const entry = open.get(key)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.handle.close()
    open.delete(key)
  }

  return {
    async watch(relative: string): Promise<void> {
      const here = root()
      if (!here) return
      const key = normalize(relative)
      if (open.has(key)) return

      // Par le même portail que la lecture : un chemin qui vient du rendu est
      // un chemin qu'on ne croit pas. `resolveInside` refuse ce qui sort du
      // projet, liens symboliques compris, et c'est la seule règle sur le
      // sujet — en écrire une seconde ici voudrait dire en avoir une faible.
      const dir = await resolveInside(here, key)

      // Non récursif, et pas seulement pour la dépense : macOS rend le nom du
      // fichier touché dans un sous-dossier sans dire dans lequel, donc un
      // événement récursif ne saurait pas quel dossier relire.
      const handle = watch(dir, { persistent: false, recursive: false }, () => {
        const entry = open.get(key)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = null
          changed(key)
        }, QUIET)
      })
      // Un dossier effacé pendant qu'on le regarde : l'écouteur meurt, et la
      // fenêtre doit l'apprendre — c'est un changement comme un autre, et son
      // parent le montrera.
      handle.on("error", () => {
        stop(key)
        changed(key)
      })
      open.set(key, { handle, timer: null })
    },

    unwatch(relative: string): void {
      stop(normalize(relative))
    },

    watched(): string[] {
      return [...open.keys()].sort()
    },

    dispose(): void {
      for (const key of [...open.keys()]) stop(key)
    },
  }
}

// normalize : une seule écriture par dossier.
//
// Le rendu dit « . » pour la racine, « src » pour un dossier, et parfois
// « src/ » selon d'où vient la chaîne. Trois écritures du même dossier, ce
// sont trois écouteurs sur le même dossier, et deux qui ne s'arrêtent jamais
// parce que personne ne redemande leur nom sous la même forme.
function normalize(relative: string): string {
  const trimmed = (relative ?? "").trim()
  if (trimmed === "" || trimmed === "." || trimmed === "./") return "."
  return path.posix.normalize(trimmed.replace(/\\/g, "/")).replace(/\/+$/, "")
}
