import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"

// Reading the source is the review. A small store has no other one, so this is
// deliberately one click from the listing rather than somewhere a curious
// person has to go looking for.

export function PackSource({ name }: { name: string }) {
  const pack = useQuery({
    queryKey: ["store", "pack", name],
    queryFn: () => window.zyvro.store.readPack(name),
  })

  if (pack.isLoading) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 zy-spin" /> Fetching the source
      </p>
    )
  }
  if (pack.isError) {
    return <p className="text-[12px] text-destructive">{(pack.error as Error).message}</p>
  }

  const sources = pack.data?.sources ?? []
  if (sources.length === 0) {
    return <p className="text-[12px] text-muted-foreground">This pack carries no readable source.</p>
  }

  return (
    <div className="space-y-2">
      {sources.map((source) => (
        <div key={source.path} className="overflow-hidden rounded-lg border border-white/[0.08] bg-black/40">
          <div className="border-b border-white/[0.06] px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
            {source.path}
          </div>
          <pre className="zy-scroll max-h-72 overflow-auto px-2.5 py-2">
            <code className="zy-selectable font-mono text-[11px] leading-relaxed text-foreground/90">
              {source.code}
            </code>
          </pre>
        </div>
      ))}
    </div>
  )
}
