import React from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { registerHost } from "@/lib/host"
import { installDaemonFetch } from "./lib/daemon"
import { queryClient } from "./lib/queryClient"
import App from "./App"
import "./styles.css"

// The interceptor must be in place before any shared module can issue a
// request, so it runs at import time rather than inside a component.
installDaemonFetch()

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
