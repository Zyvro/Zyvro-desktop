import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

// The renderer deliberately compiles the *web* app's components straight from
// Zyvro-frontend/src. The graph editor is the product; maintaining a second
// copy of it for the desktop shell would guarantee the two drift apart. The
// price is two small shims for the Next.js imports those files carry.
const webSrc = resolve(__dirname, "../Zyvro-frontend/src")

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      // The shared components live under Zyvro-frontend, which has its own
      // node_modules. Without this, Vite resolves their `react` import to that
      // copy while the desktop's own files use this one, and two React
      // instances in one tree means every hook reads a null dispatcher: the
      // app renders until the first shared component mounts, then blanks with
      // "Cannot read properties of null (reading 'useContext')".
      //
      // Every library here keeps module-level state or a context, so a second
      // copy of any of them is the same class of bug.
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@tanstack/react-query",
        "@xyflow/react",
        "@radix-ui/react-dialog",
        "zustand",
        "three",
      ],
      alias: {
        // Shims come first: an alias is matched in order, and "next/link"
        // would otherwise fall through to node_modules and fail to resolve.
        "next/link": resolve(__dirname, "src/renderer/shims/next-link.tsx"),
        "next/navigation": resolve(__dirname, "src/renderer/shims/next-navigation.ts"),
        "next/image": resolve(__dirname, "src/renderer/shims/next-image.tsx"),
        "@": webSrc,
        "~": resolve(__dirname, "src/renderer"),
      },
    },
    define: {
      // api.ts reads this at module load to find the backend. In the desktop
      // app the backend is the local daemon on a port we only learn at
      // runtime, so this placeholder is rewritten before any request goes out.
      "process.env.NEXT_PUBLIC_API_URL": JSON.stringify("http://127.0.0.1:0"),
      // NODE_ENV is deliberately not defined here. Vite sets it per command,
      // and hardcoding a fallback of "development" shipped React's development
      // build in a production bundle: slower, larger, and with StrictMode
      // double-invoking every effect in the packaged app.
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
        // The shared components keep their "use client" banners for Next.js.
        // Rollup has no use for them and would print one warning per file.
        onwarn(warning, warn) {
          if (warning.code === "MODULE_LEVEL_DIRECTIVE") return
          warn(warning)
        },
      },
    },
    plugins: [react()],
  },
})
