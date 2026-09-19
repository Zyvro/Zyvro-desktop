// Le moteur local est-il encore là ?
//
// `zyvrod` est un processus enfant, un par projet, et il peut mourir : planter,
// être tué, manquer de mémoire. Le processus principal le remarque maintenant
// (voir `main/daemon.ts`) ; ce module est ce que la fenêtre en retient.
//
// Un magasin de module et pas un état de React : l'annonce arrive par le pont,
// hors de tout composant, et la barre d'état n'est pas le seul endroit qui
// aurait à la lire. Un `useSyncExternalStore` suffit à l'afficher.
//
// Ce qu'on en fait est volontairement petit : **cesser d'afficher un chiffre
// faux**. La barre annonce « moteur local sur le port 50829 » ; quand ce port
// ne répond plus, l'annoncer est pire que de ne rien annoncer — on cherche la
// panne du côté de ce qui appelle, et le port est là, à l'écran, l'air vivant.

export type EngineDown = { code: number | null; log: string }

let down: EngineDown | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Le moteur est mort. Appelé par le pont, jamais par un composant. */
export function engineStopped(reason: EngineDown): void {
  down = reason
  notify()
}

/**
 * Le moteur est reparti — un projet vient de s'ouvrir, donc un démon vient de
 * répondre. Sans ça, la fenêtre garderait l'annonce d'une panne réparée.
 */
export function engineStarted(): void {
  if (down === null) return
  down = null
  notify()
}

export function engineDown(): EngineDown | null {
  return down
}

export function subscribeEngine(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Et l'autre question, qui n'est pas la même : **y a-t-il un moteur à qui
// parler ?**
//
// Longtemps c'était « un projet est-il ouvert », et les deux se confondaient
// parce qu'un moteur naissait avec un projet. Ce n'est plus vrai : sans projet,
// la fenêtre ouvre le dossier d'accueil, et les fournisseurs comme les agents
// restent joignables. Le panneau de l'agent demandait « as-tu un projet ? »
// pour décider s'il pouvait envoyer un message — c'est-à-dire la mauvaise
// question, celle qui refusait le travail global que Jeremy demande.

let attached = false

/** Une adresse de moteur vient d'être branchée, avec ou sans projet. */
export function engineAttached(): void {
  if (attached) return
  attached = true
  notify()
}

export function engineReady(): boolean {
  return attached && down === null
}
