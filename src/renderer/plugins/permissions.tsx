import { PermissionPicker } from "~/panels/PermissionPicker"
import { setPermission } from "~/state/permission"
import type { AgentPlugin } from "./types"

// Ce que l'agent a le droit de faire, à côté de la question qu'on lui pose :
// c'est là qu'on hésite, et un réglage rangé dans une page de préférences est
// un réglage qu'on découvre en lisant « permission refusée » au milieu d'une
// réponse.
//
// Éteint, le sélecteur disparaît mais le niveau reste celui qu'on a choisi —
// jamais le défaut. Retomber sur « Workspace » après avoir choisi « Read only »
// serait donner un droit que personne n'a donné ; il se change encore dans
// Settings › Permissions.
export const permissionsPlugin: AgentPlugin = {
  id: "permissions",
  Rail: ({ ctx }) => (
    <PermissionPicker rail value={ctx.permission} kind={ctx.kind} disabled={ctx.disabled} onChange={setPermission} />
  ),
}
