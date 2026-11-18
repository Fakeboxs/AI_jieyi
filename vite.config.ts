import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const entry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri expects a fixed port and no screen clearing.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    rollupOptions: {
      input: {
        main: entry("./index.html"),
        overlay: entry("./overlay.html"),
      },
    },
  },
});
