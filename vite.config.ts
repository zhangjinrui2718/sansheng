import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Sansheng Web · Vite config
// - React + TS
// - Dev server on 5173, proxying /api & /ws to the platform host on 127.0.0.1:2718
//   (`npm run dev` 的另一半 `dev:server` = `tsx watch src/cli/index.ts platform-serve`,
//    它的默认端口就是 2718 —— 这里写错了 proxy 就会指向一个没人听的端口)
// - Build output → dist/web (由平台宿主托管:`platform-serve` 注册 serveStatic)
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