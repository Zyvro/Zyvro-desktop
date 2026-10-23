import React from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { installCompletion } from "./lib/completion"
import { installDaemonFetch } from "./lib/daemon"
import { queryClient } from "./lib/queryClient"
import { installIncidentCapture } from "./state/bugReport"
import App from "./App"
import { ErrorBoundary } from "./panels/ErrorBoundary"
import "./styles.css"

// The interceptor must be in place before any shared module can issue a
// request, so it runs at import time rather than inside a component.
installDaemonFetch()

// La complétion en ligne est enregistrée une fois, pour toutes les langues.
// Elle ne part que si elle est allumée — l'interrupteur est dans la barre du
// bas — et son adresse passe par le même interception que le reste.
installCompletion()

// Les erreurs de la fenêtre entrent au journal du bouton bug dès le départ :
// celle qui casse le premier rendu est justement celle qu'on veut lire.
installIncidentCapture()

const container = document.getElementById("root")
if (!container) throw new Error("The renderer root element is missing from index.html.")

createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
