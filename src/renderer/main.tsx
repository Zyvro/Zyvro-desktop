import React from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { registerHost } from "@/lib/host"
import { installCompletion } from "./lib/completion"
import { installDaemonFetch } from "./lib/daemon"
import { queryClient } from "./lib/queryClient"
import App from "./App"
import "./styles.css"

// The interceptor must be in place before any shared module can issue a
// request, so it runs at import time rather than inside a component.
installDaemonFetch()

// La complétion en ligne est enregistrée une fois, pour toutes les langues.
// Elle ne part que si elle est allumée — l'interrupteur est dans la barre du
// bas — et son adresse passe par le même interception que le reste.
installCompletion()

// Tell the shared builder what this host can do. Browsing for a file needs a
// real dialog and an open project, so the web app registers nothing and its
// Browse buttons never appear.
registerHost({
  pickProjectFile: (request) => window.zyvro.files.pick(request),
})

const container = document.getElementById("root")
if (!container) throw new Error("The renderer root element is missing from index.html.")

createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
