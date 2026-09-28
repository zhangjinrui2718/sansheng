import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Sansheng Web · Vite config
// - React + TS
// - Dev server on 5173 with proxy /api & /ws to :4321 (Hono)
// - Build output → ../dist/web (served by Hono in production)
export default defineConfig(({ mode }) => ({
  root: path.resolve(__dirname, "web"),
  publicDir: path.resolve(__dirname, "web/public"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "web/src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:2718",
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:2718",
        ws: true,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/web"),
    emptyOutDir: true,
    sourcemap: mode !== "production",
    target: "es2022",
  },
}));