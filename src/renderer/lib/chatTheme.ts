import { chatTheme } from "../../shared/chatThemes"
import { getSettings, subscribeSettings } from "~/state/settings"

// Le thème du chat, posé sur la racine du document en variables CSS.
//
// Le chat ne connaît que les variables — `var(--zy-tool-read)`,
// `var(--zy-syn-keyword)` — et ce module est le seul à savoir quelles couleurs
// elles valent. Abonné au niveau du module, comme le reste de l'application :
// changer de thème dans les réglages repeint le chat tout de suite, messages
// déjà affichés compris.

let applique = ""

function appliquer(): void {
  if (typeof document === "undefined") return
  const theme = chatTheme(getSettings().chatTheme)
  if (theme.id === applique) return
  applique = theme.id
  const racine = document.documentElement
  for (const [nom, valeur] of Object.entries(theme.vars)) racine.style.setProperty(nom, valeur)
  racine.dataset.chatTheme = theme.id
}

appliquer()
subscribeSettings(appliquer)
