import { useCallback, useRef, useState } from "react"
import { CaseSensitive, ChevronDown, ChevronRight, Loader2, Regex, Replace, ReplaceAll, WholeWord, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { revealAt, subscribeSearchFocus } from "~/state/reveal"
import { history, remember } from "~/state/searchHistory"
import type { ReplaceTarget, SearchMatch, SearchResult } from "../../preload"

// Chercher dans le projet, et remplacer.
//
// Le panneau qu'on ouvre dix fois par jour dans un éditeur et qu'on ne remarque
// que le jour où il manque. Trois choses le rendent utilisable ou non :
//
// 1. **Il cherche pendant qu'on tape**, mais pas à chaque touche : on écrit
//    plus vite qu'un disque ne se parcourt, et une recherche par frappe fait
//    clignoter une liste que personne ne lit. Un silence, puis la recherche.
//
// 2. **Remplacer une occurrence et remplacer tout sont deux gestes.** Le
//    premier se fait sur la ligne qu'on regarde, le second sur ce qu'on ne
//    regarde pas — d'où le compte, écrit sur le bouton, avant de cliquer.
//
// 3. **Ce qu'on remplace est ce qu'on a vu.** La liste est une photo ; le
//    processus principal vérifie chaque passage avant de l'écrire et refuse
//    ceux qui ont bougé. Le panneau le dit quand ça arrive.

const IDLE_MS = 250

type Mode = { matchCase: boolean; wholeWord: boolean; regex: boolean }

export function SearchPanel() {
  const project = useWorkspace((s) => s.project)
  const projectDir = project?.project ?? null
  const openFile = useWorkspace((s) => s.openFile)

  const [query, setQuery] = useState("")
  const [replacement, setReplacement] = useState("")
  const [mode, setMode] = useState<Mode>({ matchCase: false, wholeWord: false, regex: false })
  const [showReplace, setShowReplace] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [include, setInclude] = useState("")
  const [exclude, setExclude] = useState("")

  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [note, setNote] = useState("")
  const [closed, setClosed] = useState<Record<string, boolean>>({})

  // Le dernier départ gagne : une recherche lancée avant celle qu'on attend
  // reviendrait après elle et remettrait l'ancienne liste à l'écran.
  const run = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Où l'on en est dans les recherches précédentes. -1 : on écrit, on ne
  // remonte pas.
  const recall = useRef(-1)

  // ⇧⌘F ouvre le panneau et met le curseur dans le champ : sans ça, on ouvre un
  // panneau puis on va cliquer dedans, ce qui n'est pas ce qu'un raccourci
  // promet. Une ref à rappel plutôt qu'un effet — le champ se présente à nous
  // au moment où il existe, et l'abonnement meurt avec lui.
  const focusTeardown = useRef<(() => void) | null>(null)
  const field = useCallback((node: HTMLInputElement | null) => {
    focusTeardown.current?.()
    focusTeardown.current = null
    if (!node) return
    node.focus()
    node.select()
    const off = subscribeSearchFocus(() => {
      node.focus()
      node.select()
    })
    focusTeardown.current = off
  }, [])

  const ask = useCallback(
    async (next: { query: string; mode: Mode; include: string; exclude: string }) => {
      if (next.query.trim() === "") {
        setResult(null)
        setError("")
        return
      }
      const mine = ++run.current
      setBusy(true)
      try {
        const found = await window.zyvro.search.find({
          query: next.query,
          matchCase: next.mode.matchCase,
          wholeWord: next.mode.wholeWord,
          regex: next.mode.regex,
          include: next.include,
          exclude: next.exclude,
        })
        if (mine !== run.current) return
        setResult(found)
        setError("")
      } catch (err) {
        if (mine !== run.current) return
        setResult(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mine === run.current) setBusy(false)
      }
    },
    []
  )

  // Un silence avant de chercher, et le silence repart à chaque frappe.
  const later = (next: { query: string; mode: Mode; include: string; exclude: string }): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void ask(next), IDLE_MS)
  }

  const onQuery = (value: string): void => {
    setQuery(value)
    setNote("")
    recall.current = -1
    later({ query: value, mode, include, exclude })
  }

  // Les flèches remontent les recherches précédentes, comme dans un terminal.
  //
  // Entrée les retient : on ne garde pas ce qui se déclenche tout seul après un
  // silence, sinon l'historique se remplit de préfixes — « w », « wo »,
  // « wor » — et ne contient plus une seule recherche entière.
  const onQueryKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const past = history(projectDir)
    if (event.key === "Enter") {
      event.preventDefault()
      remember(projectDir, query)
      recall.current = -1
      if (timer.current) clearTimeout(timer.current)
      void ask({ query, mode, include, exclude })
      return
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    if (past.length === 0) return
    event.preventDefault()
    const next = event.key === "ArrowUp" ? recall.current + 1 : recall.current - 1
    if (next < 0) {
      recall.current = -1
      setQuery("")
      return
    }
    if (next >= past.length) return
    recall.current = next
    setQuery(past[next])
    void ask({ query: past[next], mode, include, exclude })
  }

  const toggle = (key: keyof Mode): void => {
    const next = { ...mode, [key]: !mode[key] }
    setMode(next)
    void ask({ query, mode: next, include, exclude })
  }

  const replaceThese = async (targets: ReplaceTarget[] | null): Promise<void> => {
    remember(projectDir, query)
    setBusy(true)
    try {
      const done = await window.zyvro.search.replace(
        { query, matchCase: mode.matchCase, wholeWord: mode.wholeWord, regex: mode.regex, include, exclude },
        replacement,
        targets
      )
      setNote(
        `${done.matches} replaced in ${done.files} file${done.files === 1 ? "" : "s"}` +
          (done.skipped > 0 ? ` · ${done.skipped} skipped, the file had changed` : "")
      )
      await ask({ query, mode, include, exclude })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!project) return null

  const files = result?.files ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Search</span>
        {busy && <Loader2 className="h-3 w-3 zy-spin text-muted-foreground" />}
        <button
          className={cn(
            "rounded p-1 hover:bg-white/[0.07]",
            showFilters ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
          title="Files to include or exclude"
          onClick={() => setShowFilters((v) => !v)}
        >
          <span className="block h-3.5 w-3.5 text-center text-[13px] leading-[14px]">…</span>
        </button>
      </header>

      <div className="flex items-start gap-1 px-2">
        <button
          className="mt-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          title={showReplace ? "Hide replace" : "Replace"}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center rounded border border-white/[0.08] bg-white/[0.03] pl-2 focus-within:border-white/20">
            <input
              ref={field}
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={onQueryKey}
              placeholder="Search"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent py-1 text-[12px] outline-none placeholder:text-muted-foreground"
            />
            {/* Les trois modes, dans l'ordre où tout le monde les connaît. */}
            <Toggle on={mode.matchCase} title="Match case" onClick={() => toggle("matchCase")}>
              <CaseSensitive className="h-3.5 w-3.5" />
            </Toggle>
            <Toggle on={mode.wholeWord} title="Match whole word" onClick={() => toggle("wholeWord")}>
              <WholeWord className="h-3.5 w-3.5" />
            </Toggle>
            <Toggle on={mode.regex} title="Use regular expression" onClick={() => toggle("regex")}>
              <Regex className="h-3.5 w-3.5" />
            </Toggle>
          </div>

          {showReplace && (
            <div className="flex items-center gap-1">
              <input
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                placeholder="Replace"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[12px] outline-none placeholder:text-muted-foreground focus:border-white/20"
              />
              <button
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/[0.07] hover:text-foreground disabled:opacity-30"
                title={
                  result
                    ? `Replace all ${result.matches} occurrence${result.matches === 1 ? "" : "s"} in ${result.files.length} file${result.files.length === 1 ? "" : "s"}`
                    : "Replace all"
                }
                disabled={busy || !result || result.matches === 0}
                onClick={() => void replaceThese(null)}
              >
                <ReplaceAll className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {showFilters && (
            <div className="space-y-1 pb-1">
              <Filter value={include} onChange={setInclude} placeholder="files to include" onDone={() => void ask({ query, mode, include, exclude })} />
              <Filter value={exclude} onChange={setExclude} placeholder="files to exclude" onDone={() => void ask({ query, mode, include, exclude })} />
            </div>
          )}
        </div>
      </div>

      <div className="px-3 pt-2 text-[11px] text-muted-foreground">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : note ? (
          <span>{note}</span>
        ) : result ? (
          result.matches === 0 ? (
            <span>No results</span>
          ) : (
            <span>
              {result.matches} result{result.matches === 1 ? "" : "s"} in {files.length} file
              {files.length === 1 ? "" : "s"}
              {result.truncated && " — stopped early, narrow the search"}
            </span>
          )
        ) : null}
      </div>

      <div className="zy-scroll mt-1 min-h-0 flex-1 overflow-y-auto pb-2">
        {files.map((file) => {
          const shut = closed[file.path]
          return (
            <div key={file.path}>
              <div className="group flex w-full items-center gap-1 px-2 py-[3px] text-[12px] hover:bg-white/[0.05]">
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 text-left"
                  onClick={() => setClosed((c) => ({ ...c, [file.path]: !shut }))}
                >
                  {shut ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                  <span className="truncate font-medium">{basename(file.path)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dirname(file.path)}</span>
                </button>
                {/* Tout remplacer, mais dans ce fichier seulement. Entre « celle
                    que je regarde » et « les quatre-vingt-quatorze », il y a le
                    cas de tous les jours : ce fichier-ci, d'un coup. */}
                {showReplace && (
                  <button
                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
                    title={`Replace all ${file.matches.length} in ${basename(file.path)}`}
                    onClick={() =>
                      void replaceThese(
                        file.matches.map((m) => ({
                          path: file.path,
                          line: m.line,
                          column: m.column,
                          length: m.length,
                        }))
                      )
                    }
                  >
                    <ReplaceAll className="h-3 w-3" />
                  </button>
                )}
                <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[10px] text-muted-foreground">
                  {file.matches.length}
                </span>
              </div>

              {!shut &&
                file.matches.map((match) => (
                  <Row
                    key={`${match.line}:${match.column}`}
                    match={match}
                    showReplace={showReplace}
                    onOpen={() => {
                      openFile(file.path)
                      revealAt({ path: file.path, line: match.line, column: match.column, length: match.length })
                    }}
                    onReplace={() =>
                      void replaceThese([
                        { path: file.path, line: match.line, column: match.column, length: match.length },
                      ])
                    }
                  />
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Toggle({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "mr-0.5 shrink-0 rounded p-1 transition-colors",
        on ? "bg-white/[0.12] text-foreground" : "text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function Filter({
  value,
  onChange,
  onDone,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  onDone: () => void
  placeholder: string
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDone()
      }}
      placeholder={placeholder}
      spellCheck={false}
      className="w-full rounded border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground focus:border-white/20"
    />
  )
}

// Row : une occurrence, avec ce qui l'entoure.
//
// Le passage trouvé est surligné dans sa ligne. Sans ça, sur une ligne de cent
// caractères, on lit la ligne entière pour retrouver ce qu'on cherchait — et on
// le fait pour chacun des soixante-dix-neuf résultats.
function Row({
  match,
  showReplace,
  onOpen,
  onReplace,
}: {
  match: SearchMatch
  showReplace: boolean
  onOpen: () => void
  onReplace: () => void
}) {
  const before = match.text.slice(0, match.column)
  const hit = match.text.slice(match.column, match.column + match.length)
  const after = match.text.slice(match.column + match.length)
  return (
    <div className="group flex items-center gap-1 pl-6 pr-2 hover:bg-white/[0.05]">
      <button className="min-w-0 flex-1 truncate py-[2px] text-left font-mono text-[11px] leading-5" onClick={onOpen}>
        <span className="text-muted-foreground">{before.trimStart()}</span>
        <span className="rounded-[2px] bg-amber-400/25 text-foreground">{hit}</span>
        <span className="text-muted-foreground">{after}</span>
      </button>
      {showReplace && (
        <button
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-white/[0.1] hover:text-foreground group-hover:opacity-100"
          title="Replace this one"
          onClick={onReplace}
        >
          <Replace className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

function basename(p: string): string {
  const parts = p.split("/")
  return parts[parts.length - 1] || p
}

function dirname(p: string): string {
  const parts = p.split("/")
  parts.pop()
  return parts.join("/")
}
