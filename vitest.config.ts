import { defineConfig } from "vitest/config";
import path from "node:path";

const __dirname = import.meta.dirname ?? path.resolve(process.cwd());

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@shared/types/agents": path.resolve(__dirname, "shared/types/agents.ts"),
      "@shared/types/artifacts": path.resolve(__dirname, "shared/types/artifacts.ts"),
      "@shared/types/blackboard": path.resolve(__dirname, "shared/types/blackboard.ts"),
      "@shared/types/bus": path.resolve(__dirname, "shared/types/bus.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});