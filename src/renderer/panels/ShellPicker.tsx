import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import * as Menu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Shell } from "../../preload"

// Quel shell le panneau ouvre.
//
// Le défaut est `$SHELL`, le shell de connexion du compte, et il est marqué
// comme tel plutôt que d'être présenté comme un choix parmi d'autres : c'est ce
// que la machine déclare, et c'est juste presque partout. Presque — un
// émulateur de terminal peut être réglé pour en lancer un autre, et alors le
// compte dit bash pendant qu'on vit dans zsh. Ce menu existe pour ce cas-là, et
// il n'invente rien : la liste vient de `/etc/shells` et du PATH.
//
// Dans la barre d'onglets du terminal, à droite, parce que c'est là qu'on est
// quand on s'aperçoit que l'invite n'est pas la sienne.

const item =
  "flex cursor-default select-none items-start gap-2 rounded px-2 py-1 text-[12px] outline-none data-[highlighted]:bg-white/[0.09]"

export function ShellPicker() {
  const [open, setOpen] = useState(false)
  const client = useQueryClient()
  const liste = useQuery({
    queryKey: ["shells"],
    queryFn: () => window.zyvro.shell.list(),
    // Les shells d'une machine ne bougent pas pendant qu'on s'en sert.
    staleTime: Infinity,
  })

  const shells = liste.data ?? []
  const courant = shells.find((shell) => shell.current)
  // Tant que la liste n'est pas là, le déclencheur ne dit rien plutôt que de
  // dire « zsh » par défaut : une étiquette qui se corrige après coup est pire
  // qu'une étiquette qui attend.
  const label = courant?.name ?? "shell"

  const choisir = (shell: Shell) => {
    setOpen(false)
    // Le défaut se reprend en rechoisissant celui du compte : `null` est ce que
    // le principal attend pour effacer la préférence, et c'est la même chose
    // vue d'ici.
    void window.zyvro.shell
      .choose(shell.account ? null : shell.file)
      .then((next) => client.setQueryData(["shells"], next))
      .catch(() => client.invalidateQueries({ queryKey: ["shells"] }))
  }

  if (shells.length === 0) return null

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        title={`New shells open ${courant?.file ?? "your login shell"}`}
        className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-white/[0.06] hover:text-foreground data-[state=open]:bg-white/[0.08]"
      >
        <span>{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Content className="panel z-50 w-[17rem] p-1" align="end" sideOffset={6}>
          {shells.map((shell) => (
            <Menu.Item key={shell.file} onSelect={() => choisir(shell)} className={item}>
              <Check className={cn("mt-[3px] h-3 w-3 shrink-0", shell.current ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  {shell.name}
                  {shell.account && <span className="text-[10px] text-muted-foreground">login shell</span>}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{shell.file}</span>
              </span>
            </Menu.Item>
          ))}
          {/* Un shell qui tourne ne change pas de shell. Le dire ici évite de
              cliquer trois fois en attendant que l'invite se transforme. */}
          <div className="border-t border-white/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
            Applies to shells opened from now on.
          </div>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
