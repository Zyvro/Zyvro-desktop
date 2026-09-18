// Ce qu'un harnais sait faire, et qu'il annonce lui-même.
//
// Chaque CLI ouvre son flux par un événement `system/init` qui liste ses
// commandes en barre oblique — claude en annonce 107 sur cette machine, greffons
// compris, qwen en annonce 27. C'est la seule liste juste : elle vient de
// l'outil installé et de SES extensions, qui changent sans nous prévenir. Une
// liste écrite dans ce dépôt serait fausse chez la première personne qui
// installe un greffon.
//
// Elle n'arrive qu'avec un tour, donc elle est gardée : sans ça, une session
// neuve — le moment exact où l'on cherche ce qu'on peut taper — n'aurait rien à
// proposer. Gardée sur le disque aussi, pour que ce soit vrai au premier
// lancement du lendemain et pas seulement au deuxième tour.
//
// Rien de secret là-dedans : ce sont des noms de commandes.

import fs from "node:fs"
import path from "node:path"
import { app } from "electron"
import type { AgentKind } from "../shared/harness"

type Known = Partial<Record<AgentKind, string[]>>

let memoire: Known | null = null

function fichier(): string {
  return path.join(app.getPath("userData"), "harness-commands.json")
}

function charger(): Known {
  if (memoire) return memoire
  try {
    const brut = JSON.parse(fs.readFileSync(fichier(), "utf8")) as unknown
    memoire = brut && typeof brut === "object" ? (brut as Known) : {}
  } catch {
    // Pas de fichier, ou un fichier qu'on ne sait plus lire : on repart de rien
    // plutôt que de refuser d'ouvrir un menu.
    memoire = {}
  }
  return memoire
}

// commandsIn lit la liste sur un événement du flux, ou rend null quand ce n'en
// est pas un. Séparée pour être vérifiable sans lancer de CLI.
export function commandsIn(event: Record<string, unknown>): string[] | null {
  if (event.type !== "system" || event.subtype !== "init") return null
  const liste = event.slash_commands
  if (!Array.isArray(liste)) return null
  const propre = liste
    .filter((nom): nom is string => typeof nom === "string")
    .map((nom) => nom.trim().replace(/^\//, ""))
    .filter((nom) => nom !== "")
  return propre
}

export function known(kind: AgentKind): string[] {
  return charger()[kind] ?? []
}

// remember garde ce qu'un harnais vient d'annoncer, et dit si ça a changé —
// l'appelant n'a alors à prévenir la fenêtre que quand il y a de quoi.
export function remember(kind: AgentKind, commands: string[]): boolean {
  const actuelles = known(kind)
  if (actuelles.length === commands.length && actuelles.every((nom, i) => nom === commands[i])) return false
  const tout = { ...charger(), [kind]: commands }
  memoire = tout
  try {
    fs.mkdirSync(path.dirname(fichier()), { recursive: true })
    fs.writeFileSync(fichier(), JSON.stringify(tout))
  } catch {
    // Tant pis pour demain : la liste vaut pour cette session.
  }
  return true
}
