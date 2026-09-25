import { useMemo, useRef, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { useWorkspace } from "~/state/workspace"
import { parseDoc, parseInline, resolveTarget, type Block, type Inline } from "../../shared/mdoc"

// Un document Markdown, tel que l'aperçu le montre (⇧⌘V).
//
// L'arbre vient de `shared/mdoc` ; ici on n'en fait que des éléments React —
// jamais de HTML brut, donc un README venu d'ailleurs ne glisse aucune balise
// dans la fenêtre. Les liens : le web s'ouvre dehors, `#ancre` défile jusqu'au
// titre, un fichier du projet s'ouvre dans un onglet (son aperçu si c'est du
// Markdown). Les images relatives sont lues comme les autres fichiers du
// projet, par `files.read`, qui les rend en `data:`.

type Ctx = { doc: string; refs: Map<string, string>; allerA: (id: string) => void }

export function MarkdownDoc({ path, text }: { path: string; text: string }) {
  const doc = useMemo(() => parseDoc(text), [text])
  const racine = useRef<HTMLElement | null>(null)
  const allerA = (id: string): void => {
    const cible = racine.current?.querySelector(`[id="${CSS.escape(id)}"]`)
    cible?.scrollIntoView({ block: "start" })
  }
  const ctx: Ctx = { doc: path, refs: doc.refs, allerA }
  return (
    <article ref={racine} className="zy-doc zy-selectable mx-auto max-w-[860px] break-words px-10 py-8" data-markdown-doc>
      {doc.blocks.map((b, k) => (
        <BlockView key={k} block={b} ctx={ctx} />
      ))}
    </article>
  )
}

const TITRES = [
  "",
  "mt-7 mb-4 border-b border-white/[0.1] pb-2 text-[28px] font-semibold leading-tight",
  "mt-7 mb-4 border-b border-white/[0.1] pb-1.5 text-[22px] font-semibold leading-tight",
  "mt-6 mb-3 text-[18px] font-semibold",
  "mt-5 mb-3 text-[16px] font-semibold",
  "mt-5 mb-2 text-[14px] font-semibold",
  "mt-5 mb-2 text-[13px] font-semibold text-muted-foreground",
]

function BlockView({ block, ctx, tight = false }: { block: Block; ctx: Ctx; tight?: boolean }): JSX.Element {
  switch (block.t) {
    case "heading": {
      const Tag = `h${block.level}` as "h1"
      return (
        <Tag id={block.id} className={cn("text-foreground first:mt-0", TITRES[block.level])}>
          {inline(block.text, ctx)}
        </Tag>
      )
    }
    case "para":
      return <p className={cn(tight ? "my-0" : "my-3.5")}>{inline(block.text, ctx)}</p>
    case "code":
      return (
        <pre className="my-4 overflow-x-auto rounded-md border border-white/[0.07] bg-white/[0.04] px-4 py-3 font-mono text-[12.5px] leading-[1.55]">
          <code data-lang={block.lang || undefined}>{block.text}</code>
        </pre>
      )
    case "quote":
      return (
        <blockquote className="my-4 border-l-4 border-white/[0.15] pl-4 text-muted-foreground">
          {block.blocks.map((b, k) => (
            <BlockView key={k} block={b} ctx={ctx} />
          ))}
        </blockquote>
      )
    case "list": {
      const Tag = block.ordered ? "ol" : "ul"
      // Serrée : chaque élément tient en un paragraphe, dessiné sans marge.
      const serree = block.items.every((it) => it.blocks.length <= 1 || it.blocks.slice(1).every((b) => b.t === "list"))
      const taches = block.items.some((it) => it.checked !== null)
      return (
        <Tag
          start={block.ordered && block.start !== 1 ? block.start : undefined}
          className={cn("my-3.5 pl-7", block.ordered ? "list-decimal" : taches ? "list-none pl-1" : "list-disc", "[&_ol]:my-1 [&_ul]:my-1")}
        >
          {block.items.map((it, k) => (
            <li key={k} className={cn("pl-1", !serree && "my-2")}>
              {it.checked !== null && (
                <input type="checkbox" checked={it.checked} readOnly disabled className="mr-2 translate-y-[1px] accent-sky-400" />
              )}
              {it.blocks.map((b, j) =>
                b.t === "para" && serree ? (
                  <span key={j}>{inline(b.text, ctx)}</span>
                ) : (
                  <BlockView key={j} block={b} ctx={ctx} tight={serree} />
                )
              )}
            </li>
          ))}
        </Tag>
      )
    }
    case "table":
      return (
        <div className="my-4 overflow-x-auto">
          <table className="border-collapse text-[13.5px]">
            <thead>
              <tr>
                {block.head.map((c, k) => (
                  <th key={k} style={{ textAlign: block.align[k] ?? "left" }} className="border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 font-semibold">
                    {inline(c, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, k) => (
                <tr key={k} className="even:bg-white/[0.02]">
                  {block.head.map((_, j) => (
                    <td key={j} style={{ textAlign: block.align[j] ?? "left" }} className="border border-white/[0.12] px-3 py-1.5">
                      {inline(r[j] ?? "", ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case "rule":
      return <hr className="my-6 border-white/[0.12]" />
    case "html":
      return (
        <div className={cn("my-3.5", block.center && "text-center")}>
          {block.images.length > 0 && (
            <p className={cn("flex flex-wrap items-center gap-2", block.center && "justify-center")}>
              {block.images.map((im, k) => (
                <Image key={k} src={im.src} alt={im.alt} ctx={ctx} />
              ))}
            </p>
          )}
          {block.text && <p className="whitespace-pre-line">{block.text}</p>}
        </div>
      )
  }
}

function inline(text: string, ctx: Ctx): ReactNode[] {
  return render(parseInline(text, ctx.refs), ctx)
}

function render(xs: Inline[], ctx: Ctx): ReactNode[] {
  return xs.map((x, k) => {
    switch (x.t) {
      case "text":
        return x.text
      case "code":
        return (
          <code key={k} className="rounded bg-white/[0.08] px-[0.35em] py-[0.1em] font-mono text-[0.88em]">
            {x.text}
          </code>
        )
      case "strong":
        return (
          <strong key={k} className="font-semibold text-foreground">
            {render(x.children, ctx)}
          </strong>
        )
      case "em":
        return (
          <em key={k} className="italic">
            {render(x.children, ctx)}
          </em>
        )
      case "del":
        return (
          <del key={k} className="opacity-70">
            {render(x.children, ctx)}
          </del>
        )
      case "br":
        return <br key={k} />
      case "image":
        return <Image key={k} src={x.src} alt={x.alt} ctx={ctx} />
      case "link":
        return (
          <DocLink key={k} href={x.href} ctx={ctx}>
            {render(x.children, ctx)}
          </DocLink>
        )
    }
  })
}

function DocLink({ href, ctx, children }: { href: string; ctx: Ctx; children: ReactNode }) {
  const cible = resolveTarget(ctx.doc, href)
  if (!cible || cible.kind === "data") return <>{children}</>
  const suivre = (): void => {
    if (cible.kind === "web") window.open(cible.url, "_blank", "noopener,noreferrer")
    else if (cible.kind === "anchor") ctx.allerA(cible.id)
    else if (/\.(md|markdown)$/i.test(cible.path)) useWorkspace.getState().openPreview(cible.path)
    else useWorkspace.getState().openFile(cible.path)
  }
  return (
    <a
      href={cible.kind === "web" ? cible.url : `#${cible.kind === "anchor" ? cible.id : ""}`}
      title={cible.kind === "web" ? cible.url : cible.kind === "file" ? cible.path : undefined}
      className="text-sky-400 underline decoration-sky-400/40 underline-offset-2 hover:decoration-sky-400"
      onClick={(event) => {
        event.preventDefault()
        suivre()
      }}
    >
      {children}
    </a>
  )
}

// Une image : du web ou `data:` telle quelle, du projet par `files.read`.
function Image({ src, alt, ctx }: { src: string; alt: string; ctx: Ctx }) {
  const cible = resolveTarget(ctx.doc, src)
  const fichier = cible?.kind === "file" ? cible.path : null
  const lu = useQuery({
    queryKey: ["files", "read", fichier],
    queryFn: () => window.zyvro.files.read(fichier as string),
    enabled: fichier !== null,
    staleTime: 10_000,
  })
  const url =
    cible?.kind === "web" || cible?.kind === "data"
      ? cible.url
      : lu.data && "image" in lu.data
        ? lu.data.image.uri
        : // Un SVG se lit comme du texte ; dans une <img>, ses scripts ne
          // s'exécutent pas.
          lu.data && "text" in lu.data && /\.svg$/i.test(fichier ?? "")
          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(lu.data.text)}`
          : null
  if (!url) {
    // Pas (encore) d'image : son texte, pour ne pas laisser un trou muet.
    return alt ? <span className="text-muted-foreground">[{alt}]</span> : null
  }
  return <img src={url} alt={alt} className="inline-block max-w-full align-middle" loading="lazy" draggable={false} />
}
