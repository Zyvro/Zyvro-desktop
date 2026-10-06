import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Download, Loader2, Puzzle, ShieldCheck, ShieldQuestion } from "lucide-react"
import { ICONS, refreshPluginPackages, usePluginPackages } from "~/plugins/packages"
import type { PluginIcon } from "../../shared/pluginPackage"
import type { PluginInstallResult, StoreAgentPlugin } from "../../preload"

// Store › Plugins : les plugins d'agent publiés (shared/pluginPackage).
//
// Un plugin n'apporte pas de code, mais ses skills sont des instructions que
// l'agent suivra sur ce poste, avec les permissions qu'on lui a données. Les
// lire avant d'installer est donc la même revue que lire le Lua d'un pack, et
// le bouton est au même endroit.

export function StorePlugins({ search }: { search: string }): JSX.Element {
  const client = useQueryClient()
  const [reading, setReading] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Record<string, PluginInstallResult>>({})
  const listing = useQuery({ queryKey: ["store", "plugins", search], queryFn: () => window.zyvro.store.plugins(search) })
  const local = usePluginPackages()

  const install = useMutation({
    mutationFn: (name: string) => window.zyvro.store.installPlugin(name),
    onSuccess: (result) => {
      setInstalled((current) => ({ ...current, [result.name]: result }))
      refreshPluginPackages()
      void client.invalidateQueries({ queryKey: ["agent", "skills"] })
    },
  })

  const items = listing.data ?? []
  return (
    <div className="mt-4 space-y-2">
      {listing.isError && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{(listing.error as Error).message}</p>}
      {install.isError && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{(install.error as Error).message}</p>}
      {listing.isLoading && <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 zy-spin" /> Loading</p>}
      {listing.isSuccess && items.length === 0 && <p className="py-6 text-sm text-muted-foreground">No plugins published yet{search ? ` for “${search}”` : ""}.</p>}

      {items.map((plugin) => {
        const Icon = ICONS[plugin.icon as PluginIcon] ?? Puzzle
        const here = local.data?.plugins.find((p) => p.name === plugin.name)
        const current = here?.origin === "installed" && here.version === plugin.version
        const busy = install.isPending && install.variables === plugin.name
        const note = installed[plugin.name]
        return (
          <article key={plugin.name} className="panel overflow-hidden" data-store-plugin={plugin.name}>
            <div className="flex items-start gap-3 p-4">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-sm font-medium">
                  {plugin.name}
                  <span className="font-mono text-[11px] text-muted-foreground">{plugin.version}</span>
                </h2>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{plugin.description || "No description."}</p>
                {plugin.actions.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[12px]">
                    {plugin.actions.map((a) => (
                      <li key={a.id}><span className="text-foreground/90">{a.label}</span>{a.description && <span className="text-muted-foreground"> — {a.description}</span>}</li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>by {plugin.publisher_name || plugin.author || "unknown"}</span>
                  {plugin.skills.length > 0 && <span title={plugin.skills.map((s) => `${s.name}: ${s.description}`).join("\n")}>{plugin.skills.length} skill{plugin.skills.length === 1 ? "" : "s"}: {plugin.skills.map((s) => s.name).join(", ")}</span>}
                  {plugin.signature ? <span className="text-emerald-300/80">signed</span> : <span className="text-amber-300/90">unsigned</span>}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  className="rounded-lg border border-white/[0.1] px-2.5 py-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                  onClick={() => setReading(reading === plugin.name ? null : plugin.name)}
                >
                  {reading === plugin.name ? "Hide files" : "Read files"}
                </button>
                <button
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={busy || current}
                  onClick={() => install.mutate(plugin.name)}
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 zy-spin" /> : current ? <Check className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
                  {current ? "Installed" : here?.origin === "installed" ? `Update from ${here.version}` : "Install"}
                </button>
              </div>
            </div>
            {here && here.origin !== "installed" && (
              <p className="border-t border-white/[0.06] px-4 py-2 text-[11px] text-muted-foreground">
                {here.origin === "project" ? "This project has its own copy, which stays the one in use." : "A copy ships with Zyvro Studio; the installed one will replace it."}
              </p>
            )}
            {note && <InstalledNote result={note} />}
            {reading === plugin.name && <PluginFiles name={plugin.name} />}
          </article>
        )
      })}
    </div>
  )
}

function InstalledNote({ result }: { result: PluginInstallResult }): JSX.Element {
  const { verdict, publisher } = result
  return (
    <div className="border-t border-white/[0.06] px-4 py-2.5 text-[11px]">
      <p className="text-emerald-300">Installed {result.name}@{result.version}. Its buttons are in the chat&apos;s side bar; turn it off in Settings › Plugins.</p>
      {verdict.kind === "unsigned" ? (
        <p className="mt-1 flex items-start gap-1.5 text-amber-300/90"><ShieldQuestion className="mt-px h-3.5 w-3.5 shrink-0" />Not signed. Nothing ties it to {publisher || "its author"}.</p>
      ) : verdict.kind === "first-sight" ? (
        <p className="mt-1 flex items-start gap-1.5 text-muted-foreground"><ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-sky-300" />First time you have installed from {publisher}. Their key <span className="font-mono">{verdict.fingerprint}</span> is remembered.</p>
      ) : (
        <p className="mt-1 flex items-start gap-1.5 text-muted-foreground"><ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-300" />Signed by {publisher} with the same key as last time.</p>
      )}
    </div>
  )
}

function PluginFiles({ name }: { name: string }): JSX.Element {
  const plugin = useQuery({ queryKey: ["store", "plugin", name], queryFn: () => window.zyvro.store.readPlugin(name) })
  if (plugin.isLoading) return <p className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-3 text-[12px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 zy-spin" /> Reading</p>
  if (plugin.isError) return <p className="border-t border-white/[0.06] px-4 py-3 text-[12px] text-destructive">{(plugin.error as Error).message}</p>
  const files = (plugin.data as StoreAgentPlugin).files ?? []
  return (
    <div className="space-y-3 border-t border-white/[0.06] px-4 py-3">
      {files.map((file) => (
        <div key={file.path}>
          <p className="font-mono text-[11px] text-muted-foreground">{file.path}</p>
          <pre className="zy-scroll mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-white/[0.06] bg-black/30 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">{file.code}</pre>
        </div>
      ))}
    </div>
  )
}
