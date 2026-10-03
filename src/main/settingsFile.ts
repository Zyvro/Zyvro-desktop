import { app } from "electron"
import fs from "node:fs/promises"
import path from "node:path"

// Les réglages, aussi dans un fichier.
//
// Demandé par Jeremy : pouvoir téléverser et télécharger sa configuration en
// JSON, et qu'elle soit stockée dans un fichier qu'on peut retrouver. Le rendu
// garde sa copie dans son stockage — c'est elle qui répond tout de suite au
// démarrage — et l'écrit ici à chaque changement ; au démarrage, ce fichier
// gagne s'il dit autre chose, pour qu'une modification faite à la main dans un
// éditeur de texte soit reprise.
//
// Le nettoyage est celui du rendu (`sanitizeSettings`) : ce fichier ne fait que
// transporter, il n'interprète rien.

export type SettingsFile = { app: "zyvro-studio"; kind: "settings"; version: 1; settings: unknown }

export function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json")
}

export function wrap(settings: unknown): SettingsFile {
  return { app: "zyvro-studio", kind: "settings", version: 1, settings }
}

/** Les réglages d'un fichier : l'enveloppe de Zyvro, ou un objet de réglages nu. */
export function unwrap(parsed: unknown): unknown {
  if (parsed && typeof parsed === "object" && "settings" in parsed && (parsed as { app?: unknown }).app === "zyvro-studio") {
    return (parsed as SettingsFile).settings
  }
  return parsed
}

export async function readSettingsFile(file = settingsPath()): Promise<unknown | null> {
  try {
    return unwrap(JSON.parse(await fs.readFile(file, "utf8")))
  } catch {
    return null
  }
}

export async function writeSettingsFile(settings: unknown, file = settingsPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Écrit à côté puis renommé : un arrêt au milieu ne laisse pas un fichier
  // tronqué que le prochain démarrage prendrait pour des réglages vides.
  const temp = `${file}.partial`
  await fs.writeFile(temp, `${JSON.stringify(wrap(settings), null, 2)}\n`, "utf8")
  await fs.rename(temp, file)
}
