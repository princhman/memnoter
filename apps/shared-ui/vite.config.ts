import { pdfAssets } from "./pdf-assets.mjs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
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
    react(),
    pdfAssets(),
    tailwindcss(),
  ],
  build: {
    rollupOptions: {
      input: { review: new URL("./review-native.html", import.meta.url).pathname, main: new URL("./index.html", import.meta.url).pathname, editor: new URL("./editor.html", import.meta.url).pathname },
    },
  },
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
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
}));
