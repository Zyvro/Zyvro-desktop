import { useCallback, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { FileWarning, Loader2 } from "lucide-react"
import { languageFor, monaco } from "~/lib/monaco"
import { onCommand } from "~/lib/menuBridge"
import { useWorkspace } from "~/state/workspace"

// Monaco is imperative: it wants a DOM node and gives back an instance to
// dispose. The project bans useEffect, and this is precisely the case the
// doctrine points at a callback ref for — the ref fires with the node on mount
// and with null on unmount, which is the whole lifecycle we need.

type Props = { tabId: string; path: string }

export function CodeEditor({ tabId, path }: Props) {
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
  // inside Monaco, and closing a dirty tab. It reads the editor rather than the
  // store so it always writes exactly what is on screen.
  const save = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    const text = editor.getValue()
    try {
      await window.zyvro.files.write(path, text)
      clearDraft(tabId)
      setSaveError("")
      client.setQueryData(["files", "read", path], { path, text, truncated: false })
    } catch (err) {
      setSaveError((err as Error).message)
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

      const editor = monaco.editor.create(node, {
        value: draft ?? loaded,
        language: languageFor(path),
        theme: "zyvro-dark",
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 20,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: "line",
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        tabSize: 2,
        wordWrap: "off",
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      })
      editorRef.current = editor

      const changed = editor.onDidChangeModelContent(() => {
        setDraft(tabId, editor.getValue())
      })
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save())
      const menuSave = onCommand("save", () => void save())

      teardownRef.current = () => {
        menuSave()
        changed.dispose()
        editor.getModel()?.dispose()
        editor.dispose()
      }
    },
    // `draft` is deliberately absent: it is the seed value only. Including it
    // would rebuild the editor on every keystroke and throw away the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, path, save, setDraft, tabId]
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

  if (file.data && "binary" in file.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <FileWarning className="h-6 w-6" />
        <p>This file is binary or too large to edit here.</p>
        <button
          className="rounded-md border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[13px] text-foreground hover:bg-white/[0.08]"
          onClick={() => void window.zyvro.files.reveal(path)}
        >
          Reveal in file manager
        </button>
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
      <div ref={attach} className="min-h-0 flex-1" />
    </div>
  )
}
