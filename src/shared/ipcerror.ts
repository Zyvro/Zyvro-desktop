// Le message d'une erreur venue du processus principal, sans l'enveloppe
// qu'Electron lui met. Le pourquoi est au-dessus de `invoke`, dans
// src/preload/index.ts ; ici parce que les deux ponts — celui de la fenêtre et
// celui des fenêtres de capture — en ont besoin, et deux copies finiraient par
// différer.

const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/

export function plainMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (!IPC_WRAPPER.test(raw)) return raw
  // Une fois l'enveloppe retirée, le nom de la classe reste collé devant la
  // phrase — « Error: », « TypeError: » — et n'apprend rien non plus.
  const inner = raw.replace(IPC_WRAPPER, "").replace(/^[A-Za-z]*Error:\s*/, "")
  return inner || raw
}
