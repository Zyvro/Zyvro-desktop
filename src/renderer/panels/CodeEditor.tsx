import { useCallback, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Eye, FileWarning, Loader2 } from "lucide-react"
import { acquireModel, formatDocument, languageFor, monaco, releaseModel } from "~/lib/monaco"
import { onCommand } from "~/lib/menuBridge"
import { subscribeReveal, takeReveal } from "~/state/reveal"
import { useWorkspace } from "~/state/workspace"
import { registerSaver } from "~/state/savers"
import { Breadcrumbs } from "~/panels/Breadcrumbs"
import { isAbsolutePath } from "../../shared/external"
import { getSettings, subscribeSettings } from "~/state/settings"
import { lineHeightFor, type EditorSettings } from "../../shared/settings"
import { lineChanges, type LineChange } from "../../shared/linediff"
import { publishEditorStatus, registerEditor } from "~/state/editorStatus"

// Monaco is imperative: it wants a DOM node and gives back an instance to
// dispose. The project bans useEffect, and this is precisely the case the
// doctrine points at a callback ref for — the ref fires with the node on mount
// and with null on unmount, which is the whole lifecycle we need.

// `group` : le côté où cet éditeur est montré. Le même fichier ouvert des deux
// côtés (⌘\) a deux éditeurs ; les commandes du menu visent celui du groupe
// qui a la main.
type Props = { tabId: string; path: string; group?: "main" | "split" }

// Les marques de git dans la marge, comme VS Code : une barre verte pour ce
// qui est ajouté, bleue pour ce qui est modifié, un triangle rouge là où des
// lignes ont disparu. Et leur rappel dans l'ascenseur, à gauche.
const GIT_MARK: Record<LineChange["kind"], { className: string; color: string }> = {
  added: { className: "zy-git-added", color: "#2ea04399" },
  modified: { className: "zy-git-modified", color: "#1f6febaa" },
  deleted: { className: "zy-git-deleted", color: "#f8514999" },
}

function gitDecorations(changes: LineChange[]): monaco.editor.IModelDeltaDecoration[] {
  return changes.map((c) => {
    // Une suppression tout en haut se marque sur la première ligne, par le haut.
    const ligne = Math.max(1, c.start)
    const mark = GIT_MARK[c.kind]
    return {
      range: new monaco.Range(ligne, 1, c.kind === "deleted" ? ligne : c.end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: c.kind === "deleted" && c.start === 0 ? "zy-git-deleted-top" : mark.className,
        overviewRuler: { color: mark.color, position: monaco.editor.OverviewRulerLane.Left },
      },
    }
  })
}

// Ce que les réglages changent dans un éditeur déjà ouvert. Les mêmes options à
// la création et à chaque changement : deux listes, c'est un réglage qui ne
// prend effet qu'au prochain fichier ouvert.
function optionsFrom(r: EditorSettings): monaco.editor.IEditorOptions {
  return {
    fontSize: r.fontSize,
    lineHeight: lineHeightFor(r.fontSize),
    minimap: { enabled: r.minimap },
    wordWrap: r.wordWrap,
    lineNumbers: r.lineNumbers,
    renderWhitespace: r.renderWhitespace,
    bracketPairColorization: { enabled: r.bracketPairColorization },
    // Les guides suivent les couleurs : une ligne verticale de la couleur de
    // la paire qu'on est en train de lire.
    guides: { bracketPairs: r.bracketPairColorization ? "active" : false },
    stickyScroll: { enabled: r.stickyScroll },
  }
}

export function CodeEditor({ tabId, path, group = "main" }: Props) {
  const setDraft = useWorkspace((s) => s.setDraft)
  const clearDraft = useWorkspace((s) => s.clearDraft)
  const draft = useWorkspace((s) => s.drafts[tabId])
  const client = useQueryClient()
  const [saveError, setSaveError] = useState("")

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const teardownRef = useRef<(() => void) | null>(null)

  const file = useQuery({
    queryKey: ["files", "read", path],
    queryFn: () => window.zyvro.files.read(path),
    staleTime: Infinity,
  })

  const loaded = file.data && "text" in file.data ? file.data.text : null

  // save is the one operation several things trigger: the File menu, Cmd+S
  // inside Monaco, Save All, and closing a dirty tab. It reads the editor rather
  // than the store so it always writes exactly what is on screen. It says
  // whether it worked, because closing a tab after a failed save would lose
  // exactly what the person asked to keep.
  //
  // Format on Save, as in VS Code: an explicit save (⌘S, Save All, closing)
  // formats first; an automatic one never rewrites what is being typed.
  const save = useCallback(async (auto = false): Promise<boolean> => {
    const editor = editorRef.current
    if (!editor) return false
    if (!auto && getSettings().formatOnSave) await formatDocument(editor)
    const text = editor.getValue()
    try {
      await window.zyvro.files.write(path, text)
      clearDraft(tabId)
      setSaveError("")
      client.setQueryData(["files", "read", path], { path, text, truncated: false })
      return true
    } catch (err) {
      setSaveError((err as Error).message)
      return false
    }
  }, [client, clearDraft, path, tabId])

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        teardownRef.current?.()
        teardownRef.current = null
        editorRef.current = null
        return
      }
      if (loaded === null) return

      const reglages = getSettings()
      // Un modèle à l'adresse du fichier (voir `modelUri`). Celui d'un onglet
      // précédent du même fichier est remplacé : deux modèles ne peuvent pas
      // porter la même adresse.
      //
      // Partagé quand le même fichier est ouvert des deux côtés (⌘\) : le
      // second éditeur prend le modèle du premier, texte et réglages compris.
      const { model, fresh } = acquireModel(path, draft ?? loaded)
      // L'indentation se règle sur le modèle : passée à l'éditeur, elle ne
      // valait que pour un modèle qu'il aurait créé lui-même.
      if (fresh && reglages.detectIndentation) model.detectIndentation(reglages.insertSpaces, reglages.tabSize)
      else if (fresh) model.updateOptions({ tabSize: reglages.tabSize, insertSpaces: reglages.insertSpaces })
      const editor = monaco.editor.create(node, {
        model,
        theme: "zyvro-dark",
        automaticLayout: true,
        ...optionsFrom(reglages),
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        tabSize: reglages.tabSize,
        insertSpaces: reglages.insertSpaces,
        detectIndentation: reglages.detectIndentation,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        // Un fichier lâché depuis le Finder sur l'éditeur s'ouvre dans un
        // onglet, comme dans VS Code (`lib/windowDrop.ts`). Monaco, lui,
        // voudrait coller son chemin dans le texte, et il passerait avant.
        dropIntoEditor: { enabled: false },
      })
      editorRef.current = editor

      // Un réglage changé s'applique tout de suite, à tous les éditeurs
      // ouverts. L'indentation seulement quand on ne la devine pas : un
      // fichier en tabulations reste en tabulations.
      const offSettings = subscribeSettings(() => {
        const r = getSettings()
        editor.updateOptions(optionsFrom(r))
        if (!r.detectIndentation) editor.getModel()?.updateOptions({ tabSize: r.tabSize, insertSpaces: r.insertSpaces })
      })

      // La sauvegarde automatique, comme VS Code : après un délai sans frappe,
      // ou quand l'éditeur perd le focus — un autre onglet, un autre panneau,
      // une autre application. Seulement ce qui a un brouillon.
      let minuterie: ReturnType<typeof setTimeout> | null = null
      const modifie = () => tabId in useWorkspace.getState().drafts
      const sauverSiModifie = () => {
        if (minuterie) clearTimeout(minuterie)
        minuterie = null
        if (modifie()) void save(true)
      }
      const apresFrappe = () => {
        const r = getSettings()
        if (r.autoSave !== "afterDelay") return
        if (minuterie) clearTimeout(minuterie)
        minuterie = setTimeout(sauverSiModifie, r.autoSaveDelay)
      }
      const perdFocus = () => {
        if (getSettings().autoSave === "onFocusChange") sauverSiModifie()
      }
      const blurred = editor.onDidBlurEditorText(perdFocus)

      // La marge de git. Le texte du dernier commit est demandé à l'ouverture,
      // puis de nouveau quand HEAD bouge — un commit, un checkout — que le
      // statut de git, déjà sondé pour le panneau, dit sans rien coûter de
      // plus. Le diff se refait après la frappe, pas à chaque touche.
      const marques = editor.createDecorationsCollection()
      let head: string | null = null
      let headDe = ""
      let calcul: ReturnType<typeof setTimeout> | null = null
      const recalculer = () => {
        if (calcul) clearTimeout(calcul)
        calcul = setTimeout(() => {
          calcul = null
          marques.set(head === null ? [] : gitDecorations(lineChanges(head, editor.getValue())))
        }, 250)
      }
      const relireHead = () => {
        // Un fichier hors du projet n'est pas dans son dépôt.
        if (isAbsolutePath(path)) return
        void window.zyvro.git.headText(path).then(
          (texte) => {
            head = texte
            recalculer()
          },
          () => undefined
        )
      }
      relireHead()
      const offGit = client.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey
        if (event.type !== "updated" || key[0] !== "git" || key[1] !== "status") return
        const data = event.query.state.data as { repository?: boolean; head?: string | null } | undefined
        const sha = data?.repository ? (data.head ?? "") : ""
        if (sha !== headDe) {
          headDe = sha
          relireHead()
        }
      })
      window.addEventListener("blur", perdFocus)

      // Ce que la barre d'état affiche de cet éditeur. Publié à chaque
      // mouvement du curseur et à chaque changement d'options du modèle ; le
      // magasin ignore ce qui n'a pas bougé.
      const langue = languageFor(path)
      const nomDeLangue =
        monaco.languages.getLanguages().find((l) => l.id === langue)?.aliases?.[0] ?? langue
      const publier = (): void => {
        const model = editor.getModel()
        if (!model) return
        const position = editor.getPosition()
        const selection = editor.getSelection()
        const options = model.getOptions()
        publishEditorStatus(tabId, {
          line: position?.lineNumber ?? 1,
          column: position?.column ?? 1,
          selected: selection && !selection.isEmpty() ? model.getValueInRange(selection).length : 0,
          language: nomDeLangue,
          eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
          insertSpaces: options.insertSpaces,
          tabSize: options.tabSize,
        })
      }
      publier()
      const cursorMoved = editor.onDidChangeCursorSelection(publier)
      const optionsChanged = editor.getModel()?.onDidChangeOptions(publier)
      const unregisterEditor = registerEditor(tabId, {
        goToLine: () => {
          editor.focus()
          void editor.getAction("editor.action.gotoLine")?.run()
        },
        // Changer les fins de ligne change le texte : c'est un brouillon comme
        // un autre, à enregistrer, et Monaco le signale par un changement de
        // contenu.
        setEol: (eol) => {
          editor.getModel()?.pushEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF)
          publier()
        },
        setIndentation: (insertSpaces, tabSize) => {
          editor.getModel()?.updateOptions({ insertSpaces, tabSize })
        },
      })

      // Revenu exactement au texte enregistré — une frappe puis son
      // effacement, ou une annulation jusqu'au bout — le fichier n'est plus
      // modifié : c'est ce que fait VS Code, et c'est ce qu'on voit. Sans ça
      // l'onglet gardait son point, et le fermer posait une question sur des
      // modifications qui n'existaient pas.
      const changed = editor.onDidChangeModelContent(() => {
        const texte = editor.getValue()
        const enregistre = client.getQueryData<{ text?: string }>(["files", "read", path])?.text
        if (texte === enregistre) clearDraft(tabId)
        else {
          setDraft(tabId, texte)
          apresFrappe()
        }
        recalculer()
      })

      // Aller à un résultat de recherche : le panneau ouvre le fichier et
      // dépose l'endroit ; l'éditeur le prend quand il existe. Les deux cas
      // comptent — l'onglet vient de naître, ou il était déjà là.
      const goTo = (): void => {
        const request = takeReveal(path)
        if (!request) return
        const range = {
          startLineNumber: request.line + 1,
          startColumn: request.column + 1,
          endLineNumber: request.line + 1,
          endColumn: request.column + request.length + 1,
        }
        editor.setSelection(range)
        editor.revealRangeInCenter(range)
        editor.focus()
      }
      goTo()
      const offReveal = subscribeReveal(goTo)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())
      // Le menu Save, Save All et la fermeture d'un onglet modifié passent par
      // le registre, qui vise un onglet. Écouter la commande ici faisait
      // enregistrer tous les éditeurs montés à la fois — onglets cachés compris.
      const unregister = registerSaver(tabId, () => save())
      // La barre de recherche de Monaco, celle que ⌘F ouvre partout ailleurs.
      // Seul l'éditeur visible répond : les autres onglets restent montés, et
      // ouvrir la recherche dans un fichier qu'on ne regarde pas ne servirait
      // personne.
      // Visible, et du côté qui a la main quand l'éditeur est partagé en deux.
      const visible = () =>
        node.isConnected && node.offsetParent !== null && useWorkspace.getState().focusedGroup === group
      const menuFind = onCommand("find", () => {
        if (!visible()) return
        editor.focus()
        void editor.getAction("actions.find")?.run()
      })
      // Le plan du fichier (⇧⌘O) et Go to Line (⌃G) : les actions de Monaco,
      // pour l'éditeur visible seulement, comme ⌘F.
      const menuSymbol = onCommand("go-to-symbol", () => {
        if (!visible()) return
        editor.focus()
        void editor.getAction("editor.action.quickOutline")?.run()
      })
      const menuLine = onCommand("go-to-line", () => {
        if (!visible()) return
        editor.focus()
        void editor.getAction("editor.action.gotoLine")?.run()
      })
      const menuFormat = onCommand("format-document", () => {
        if (!visible()) return
        editor.focus()
        void formatDocument(editor)
      })

      teardownRef.current = () => {
        offReveal()
        menuFind()
        menuSymbol()
        menuLine()
        menuFormat()
        unregister()
        unregisterEditor()
        offSettings()
        offGit()
        if (calcul) clearTimeout(calcul)
        marques.clear()
        blurred.dispose()
        window.removeEventListener("blur", perdFocus)
        if (minuterie) clearTimeout(minuterie)
        cursorMoved.dispose()
        optionsChanged?.dispose()
        changed.dispose()
        editor.dispose()
        releaseModel(model)
      }
    },
    // `draft` is deliberately absent: it is the seed value only. Including it
    // would rebuild the editor on every keystroke and throw away the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, clearDraft, group, loaded, path, save, setDraft, tabId]
  )

  if (file.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 zy-spin" /> Opening {path}
      </div>
    )
  }

  if (file.isError) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-destructive">
        {(file.error as Error).message}
      </div>
    )
  }

  // Une image se regarde plutôt que de s'annoncer comme illisible.
  //
  // `object-contain` et pas `cover` : une capture qu'on recadre pour remplir le
  // cadre est une capture dont on a coupé ce qu'on voulait voir. Le damier
  // derrière dit ce qui est transparent, ce qu'un fond uni cache — un logo
  // blanc sur fond blanc a l'air vide sinon.
  if (file.data && "image" in file.data) {
    const image = file.data.image
    return (
      <div className="zy-checker flex h-full items-center justify-center overflow-auto p-6">
        <img
          src={image.uri}
          alt={path}
          className="max-h-full max-w-full object-contain"
          style={{ imageRendering: "auto" }}
        />
      </div>
    )
  }

  // Ce que Cursor et VS Code montrent : le fichier n'est pas ouvert d'office —
  // un exécutable décodé en texte est illisible, et l'enregistrer le détruit —
  // mais « Open Anyway » l'ouvre quand même, pour le journal au NUL égaré ou le
  // texte d'un encodage exotique. Le texte forcé remplace la lecture en cache :
  // l'onglet devient un éditeur ordinaire.
  if (file.data && "binary" in file.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center text-[14px] text-foreground/90">
        <FileWarning className="h-12 w-12 text-amber-300" strokeWidth={1.5} />
        <p className="max-w-md">
          The file is not displayed in the text editor because it is either binary, too large, or uses an
          unsupported text encoding.
        </p>
        <div className="flex gap-2">
          <button
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() =>
              void window.zyvro.files.read(path, true).then(
                (forced) => client.setQueryData(["files", "read", path], forced),
                (err: Error) => setSaveError(err.message)
              )
            }
          >
            Open Anyway
          </button>
          <button
            className="rounded-md border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[13px] hover:bg-white/[0.08]"
            onClick={() => void window.zyvro.files.reveal(path)}
          >
            {window.zyvro.platform === "darwin" ? "Reveal in Finder" : "Reveal in File Explorer"}
          </button>
        </div>
        {saveError && <p className="text-[12px] text-destructive">{saveError}</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {saveError && (
        <p className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
          {saveError}
        </p>
      )}
      <Breadcrumbs path={path} />
      <div className="relative min-h-0 flex-1">
        <div ref={attach} className="absolute inset-0" />
        {/* Un fichier Markdown s'ouvre aussi rendu, d'un clic, comme dans VS
            Code. En haut à droite, là où la minimap ne vient pas. */}
        {isMarkdown(path) && (
          <button
            className="absolute right-5 top-2 z-10 flex items-center gap-1 rounded-md border border-white/[0.1] bg-background/80 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            title="Open Preview (⇧⌘V)"
            onClick={() => useWorkspace.getState().openPreview(path)}
          >
            <Eye className="h-3 w-3" /> Preview
          </button>
        )}
      </div>
    </div>
  )
}

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}
