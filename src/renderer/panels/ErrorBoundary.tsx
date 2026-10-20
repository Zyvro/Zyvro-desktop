import { Component, type ErrorInfo, type ReactNode } from "react"
import { reportIncident } from "~/state/bugReport"

// Une erreur de rendu ne doit pas laisser une fenêtre blanche.
//
// Sans garde, une exception levée pendant le rendu d'un composant démonte TOUT l'arbre de
// React : la fenêtre devient blanche, sans bouton, sans message, et la seule issue est de la
// fermer — alors que les shells et les agents tournent encore dans le processus principal et
// que le rendu pourrait simplement les reprendre. Ce garde attrape l'erreur, la note au
// journal du bouton bug, et propose de recharger la fenêtre. Un seul niveau, tout en haut :
// c'est le filet, pas la gestion d'erreur de chaque panneau.
//
// Une classe, parce que React n'offre pas d'autre moyen d'attraper une erreur de rendu : il
// n'y a pas d'équivalent en fonction. Ce n'est pas un effet, et le dépôt n'en a pas banni.

type State = { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      reportIncident("renderer:render-error", `${error.stack ?? error.message}\n${info.componentStack ?? ""}`)
    } catch {
      // Le journal est un confort : il ne doit pas lever à son tour.
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground" role="alert">
        <p className="text-[14px] font-medium">Something went wrong in this window.</p>
        <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
          Your shells and agents are still running — reloading the window picks them up where they were.
        </p>
        <pre className="max-h-32 max-w-xl overflow-auto rounded-md border border-white/[0.08] bg-white/[0.03] p-2 text-left text-[11px] text-muted-foreground">
          {this.state.error.message}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-8 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:opacity-90"
          >
            Reload the window
          </button>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="h-8 rounded-md border border-white/[0.1] px-3 text-[12px] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}
