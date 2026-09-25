// Ce que la barre d'état dit de l'éditeur actif : où est le curseur, quelle
// langue, quelles fins de ligne, quelle indentation.
//
// Rien de tout ça ne s'affichait. Or c'est ce qu'on regarde pour savoir à quelle
// ligne pointe une erreur, pourquoi un fichier fait un diff de toutes ses
// lignes (CRLF), ou pourquoi une tabulation insère deux espaces au lieu de
// quatre.
//
// Un magasin de module par onglet, comme les enregistreurs : l'éditeur écrit,
// la barre lit celui de l'onglet actif. Et l'éditeur y dépose aussi deux gestes
// que la barre déclenche au clic — aller à une ligne, changer les fins de
// ligne — parce qu'il est le seul à tenir l'instance de Monaco.

export type EditorStatus = {
  line: number
  column: number
  /** Caractères sélectionnés, 0 sans sélection. */
  selected: number
  /** Le nom lisible de la langue : « TypeScript », pas « typescript ». */
  language: string
  eol: "LF" | "CRLF"
  insertSpaces: boolean
  tabSize: number
}

export type EditorActions = {
  goToLine: () => void
  setEol: (eol: "LF" | "CRLF") => void
  setIndentation: (insertSpaces: boolean, tabSize: number) => void
}

const statuses = new Map<string, EditorStatus>()
// Une pile par onglet, comme les enregistreurs (state/savers) : un fichier
// ouvert des deux côtés a deux éditeurs.
const actions = new Map<string, EditorActions[]>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeEditorStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Rend le même objet tant que rien n'a changé : `useSyncExternalStore` le veut. */
export function editorStatusOf(tabId: string): EditorStatus | null {
  return statuses.get(tabId) ?? null
}

export function editorActionsOf(tabId: string): EditorActions | null {
  const pile = actions.get(tabId)
  return pile?.[pile.length - 1] ?? null
}

export function publishEditorStatus(tabId: string, status: EditorStatus): void {
  const before = statuses.get(tabId)
  if (
    before &&
    before.line === status.line &&
    before.column === status.column &&
    before.selected === status.selected &&
    before.language === status.language &&
    before.eol === status.eol &&
    before.insertSpaces === status.insertSpaces &&
    before.tabSize === status.tabSize
  ) {
    return
  }
  statuses.set(tabId, status)
  emit()
}

/** L'éditeur d'un onglet s'inscrit ; la fonction rendue efface tout ce qu'il a déposé. */
export function registerEditor(tabId: string, given: EditorActions): () => void {
  actions.set(tabId, [...(actions.get(tabId) ?? []), given])
  return () => {
    const reste = (actions.get(tabId) ?? []).filter((a) => a !== given)
    if (reste.length > 0) {
      actions.set(tabId, reste)
      return
    }
    actions.delete(tabId)
    statuses.delete(tabId)
    emit()
  }
}

// statusText : la position, comme VS Code l'écrit. Pur, pour le vérifier.
export function positionText(status: Pick<EditorStatus, "line" | "column" | "selected">): string {
  const base = `Ln ${status.line}, Col ${status.column}`
  return status.selected > 0 ? `${base} (${status.selected} selected)` : base
}

export function indentationText(status: Pick<EditorStatus, "insertSpaces" | "tabSize">): string {
  return status.insertSpaces ? `Spaces: ${status.tabSize}` : `Tab Size: ${status.tabSize}`
}
