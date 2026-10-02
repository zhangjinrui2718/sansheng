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
    // 批次 5b-1:全局关闭 decide LLM 的真实网络路径(测试卫生)。
    // SANSHENG_DECIDE_LLM=0 → makeLlmCommunicatorDecide 直接降级正则,集成测试
    // 用 fake apiKey 时不会每条消息都发真实分类请求;需要 LLM 行为的测试注入
    // llmCall(绕过闸门)。生产 index.ts/cli 不设此变量 → 闸门默认开。
    setupFiles: ["./tests/setup-env.ts"],
  },
});