import { useCallback, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { languageFor, monaco } from "~/lib/monaco"
import { gitKey } from "~/lib/git"

// A change, shown side by side.
//
// Monaco brings a real diff editor, so this does not reimplement one: the two
// sides are fetched as whole files and handed to it. A unified patch would have
// been less work and worse — you cannot scroll a patch past its context, and
// the context is exactly where you look to decide whether a change is right.
//
// Which two files depends on which list the row was in, and it is not a detail:
//
//   staged    HEAD            → the index      ("what this commit will contain")
//   working   the index       → the disk       ("what I have not staged yet")
//
// Getting that pair backwards would show a plausible diff of the wrong two
// things, which is the kind of wrong nobody notices until they commit.

//   commit    son parent      → ce commit      ("ce que ce commit a changé",
//                                               depuis la Timeline)
type Props = { path: string; staged: boolean; commit?: string }

export function DiffView({ path, staged, commit }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const modelsRef = useRef<monaco.editor.ITextModel[]>([])

  const sides = useQuery({
    queryKey: [...gitKey, "diff-sides", path, staged, commit ?? ""],
    queryFn: async () => {
      // Un premier commit n'a pas de parent : `fileAt` rend alors un côté
      // vide, ce qui est vrai — le fichier naissait.
      if (commit) {
        const [left, right] = await Promise.all([
          window.zyvro.git.fileAt(path, `${commit}^`),
          window.zyvro.git.fileAt(path, commit),
        ])
        return { left, right }
      }
      // `:path` with an empty revision is git's way of naming the index, which
      // is the one of the three states that has no file on disk to read.
      const left = await window.zyvro.git.fileAt(path, staged ? "HEAD" : "")
      if (staged) {
        return { left, right: await window.zyvro.git.fileAt(path, "") }
      }
      const onDisk = await window.zyvro.files.read(path)
      return { left, right: "text" in onDisk ? onDisk.text : "" }
    },
  })

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        editorRef.current?.dispose()
        editorRef.current = null
        for (const model of modelsRef.current) model.dispose()
        modelsRef.current = []
        return
      }
      if (!sides.data) return

      const language = languageFor(path)
      const original = monaco.editor.createModel(sides.data.left, language)
      const modified = monaco.editor.createModel(sides.data.right, language)
      modelsRef.current = [original, modified]

      const editor = monaco.editor.createDiffEditor(node, {
        theme: "zyvro-dark",
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 20,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        // Read-only on both sides. Editing the left one is meaningless, and
        // editing the right one here would be a second place a file can be
        // changed, with no save and no dirty marker to show for it.
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        ignoreTrimWhitespace: false,
      })
      editor.setModel({ original, modified })
      editorRef.current = editor
    },
    // The node is handed back when the data arrives, which is what makes this a
    // callback ref and not an effect: React calls it again because the identity
    // changed, and the teardown above has already run.
    [path, sides.data]
  )

  if (sides.isLoading) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 zy-spin" /> Reading both sides
      </p>
    )
  }
  if (sides.isError) {
    return <p className="p-4 text-sm text-destructive">{(sides.error as Error).message}</p>
  }
  if (sides.data && sides.data.left === sides.data.right) {
    return <p className="p-4 text-sm text-muted-foreground">No difference between these two versions.</p>
  }

  return <div ref={attach} className="h-full w-full" />
}
