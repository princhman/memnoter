import { pdfAssets } from "./pdf-assets.mjs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Shown in Settings → About so a tester can tell which commit is installed.
function buildStamp() {
  try {
    const git = (args: string) => execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = git("status --porcelain --untracked-files=no") ? "-dirty" : "";
    return `${git("rev-parse --short HEAD")}${dirty}`;
  } catch {
    return "unknown";
  }
}

// Device mode deliberately omits React Refresh and the Vite client. Reloads
// must drain native writes first; neither HMR nor an unguarded reload is safe.
const deviceDev = process.env.MEMNOTER_DEVICE_DEV === "1";
let deviceRevision = `${Date.now()}:0`;
let revision = 0;
// https://vite.dev/config/
export default defineConfig(async () => ({
  // WKWebView loads editor.html from the bundled dist directory.
  base: "./",
  define: {
    "import.meta.env.VITE_BUILD_STAMP": JSON.stringify(buildStamp()),
  },
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    ...(deviceDev ? [{
      name: "ios-safe-reload",
      configureServer(server: import("vite").ViteDevServer) {
        server.middlewares.use("/@vite/client", (_req, res) => {
          res.setHeader("Content-Type", "text/javascript");
          res.end(readFileSync(new URL("./ios-vite-client.mjs", import.meta.url), "utf8"));
        });
        server.watcher.on("all", (_event, file) => {
          if (!file.includes("node_modules") && !file.includes("/.git/")) deviceRevision = `${Date.now()}:${++revision}`;
        });
        server.middlewares.use("/__ios_revision", (_req, res) => {
          res.setHeader("Cache-Control", "no-store");
          res.end(deviceRevision);
        });
      },
      transformIndexHtml: {
        order: "post" as const,
        handler(html: string) {
          return html.replace(/<script type="module" src="\/@vite\/client"><\/script>/, "")
            .replace("</head>", '<script type="module" src="/src/editor-host/live-reload.ts"></script></head>');
        },
      },
    }] : [react()]),
    pdfAssets(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      input: { review: new URL("./review-native.html", import.meta.url).pathname, main: new URL("./index.html", import.meta.url).pathname, editor: new URL("./editor.html", import.meta.url).pathname },
    },
  },
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: deviceDev ? false : host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
}));
