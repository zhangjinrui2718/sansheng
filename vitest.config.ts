import { defineConfig } from "vitest/config";
import path from "node:path";

const __dirname = import.meta.dirname ?? path.resolve(process.cwd());

export default defineConfig({
  // `.tsx` 源码在 vitest 里走 esbuild 直转,而 esbuild 默认是 **classic** JSX runtime
  // (要求每个 tsx 文件自己 import React)—— 应用构建走的是 `@vitejs/plugin-react`,
  // 那是 automatic runtime。两边不一致的后果:组件源码在测试里报
  // `React is not defined`,而生产构建完全正常 —— 一种只在测试里出现的假故障。
  // 这里显式对齐成 automatic(只影响 jsx 转换,不碰任何既有测试的解析)。
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      // 与 vite.config.ts 保持一致(`@` → web/src)。tsconfig 的 paths 只喂
      // typecheck,vitest 走自己的解析 —— 不加这条,测试 import 不到
      // `web/src/lib/artifacts.ts`(它内部 import `@/stores/chat`)。
      // 2026-10-02 批次 U4-G:目标页「不静默丢数据」的判据抽成纯函数要单测,
      // 这条别名是前提。只加不加改,不影响既有 `@shared/*` 解析。
      "@": path.resolve(__dirname, "web/src"),
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