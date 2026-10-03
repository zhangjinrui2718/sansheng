/**
 * 批次 UI U4-F —— 「假空态」的回归守护
 *
 * ## 起因(2026-10-02,用户看页面时发现)
 *
 * 用户看到 Agent 页显示:
 *
 *     Agent 工作面
 *     本会话的 blackboard
 *     本会话还没有工件。发送 /plan 你的目标 后,意图与待办会出现在这里。
 *
 * 查证结论(见 commit dd1eeb6 之后的 fix):**那句「还没有工件」在首次挂载时
 * 是假的**。`useArtifacts` 的 `loading` 初值是 `false`,于是页面首帧拿到
 * `{loading:false, artifacts:[]}` —— 此时 fetch 还没发出去,页面已经替用户
 * 断言了「本会话没有工件」。于是每次切到该页,必然依次闪:
 *
 *     「还没有工件」→「加载中…」→ 真实结果
 *
 * 「还没查过」被当成了「查过了,是空」。这是界面在说假话,和 c10-dead-code
 * 守的那几项(空头承诺 / 恒 null 的端点)是同一类。
 *
 * ## 这里守什么
 *
 * 三条硬规则,都是静态可判的:
 *  1. `useArtifacts` 的 `loading` 初值必须是 `true`;
 *  2. 每个渲染工件的页面,在「还没有工件」之前必须先判 `loading`;
 *  3. 空态文案不许把占位符写成像字面量(下面第 3 条单独讲)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const WEB_SRC = join(REPO, "web/src");

const read = (rel: string): string => readFileSync(join(WEB_SRC, rel), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("U4-F · 没查过 ≠ 查过了是空", () => {
  it("useArtifacts 的 loading 初值是 true,不是 false", () => {
    const src = stripComments(read("lib/artifacts.ts"));
    const init = src.match(/const\s+\[\s*loading\s*,\s*setLoading\s*\]\s*=\s*useState\(([^)]*)\)/);
    expect(init, "找不到 useArtifacts 里的 loading 初始化").not.toBeNull();
    expect(init?.[1]?.trim()).toBe("true");
  });

  it("AgentPanel 用了 loading(此前它直接跳到「还没有工件」)", () => {
    const src = stripComments(read("components/shell/AgentPanel.tsx"));
    expect(src).toMatch(/\}\s*=\s*useArtifacts\([^)]*pollMs/);
    expect(src).toMatch(/const\s*\{\s*artifacts\s*,\s*loading\s*,/);
    expect(src).toMatch(/loading\s*&&\s*artifacts\.length\s*===\s*0/);
  });

  it("四个渲染工件的页面都在空态之前先判 loading", () => {
    for (const rel of [
      "routes/Agents.tsx",
      "routes/Artifacts.tsx",
      "routes/Goals.tsx",
      "components/shell/AgentPanel.tsx",
    ]) {
      const src = stripComments(read(rel));
      // 「没有工件」这一支的判据里必须含 loading,否则首帧就是假空态。
      expect(src, rel).toMatch(/loading\s*&&\s*\w+\.length\s*===\s*0/);
    }
  });
});

describe("U4-F · 空态不许把占位符写成像字面量", () => {
  /**
   * 「发送 /plan 你的目标 后…」—— 读起来像**要照抄的字面量**,而
   * ChatSurface 判的是 `text.startsWith("/plan ")`,照抄进去 goal 就真的是
   * 「你的目标」四个字,规划员会老老实实去规划「你的目标」。
   * 正确写法是「以 /plan 开头发一条,后面跟你的目标」,句式本身说明只有
   * /plan 是字面量。
   */
  it("不许出现 `发送 /plan 你的目标` 这类可被照抄的占位符", () => {
    for (const rel of ["routes/Agents.tsx", "routes/Goals.tsx", "routes/Artifacts.tsx"]) {
      expect(stripComments(read(rel)), rel).not.toMatch(/\/plan\s*你的目标/);
    }
  });

  it("ChatSurface 仍按 `/plan ` 前缀解析(改了文案别改接线)", () => {
    const src = stripComments(read("components/chat/ChatSurface.tsx"));
    expect(src).toMatch(/text\.startsWith\("\/plan "\)/);
  });
});

describe("U4-F · 内部术语不上屏", () => {
  /**
   * `blackboard` 是后端表/模块名,不是用户会用的词。批次 U4 把页面标题从
   * 「Agents & Blackboard」改成了「Agent 工作面」,却把 hint 里的
   * 「本会话的 blackboard」留下了 —— 同一个词在同一页既删又留。
   *
   * 只查「去掉注释与 import 之后」的源码:`import type … from "@shared/types/
   * blackboard"` 里的 blackboard 是真实的类型路径,必须留着。
   */
  const onScreenSource = (rel: string): string =>
    stripComments(read(rel))
      .replace(/^\s*import[^\n]*$/gm, "")
      .replace(/hintTitle=\{[\s\S]*?\n\s*\}/g, "");

  it("工件相关页面的可见文案里不出现 blackboard", () => {
    for (const rel of ["routes/Agents.tsx", "routes/Goals.tsx", "routes/Artifacts.tsx"]) {
      expect(onScreenSource(rel), rel).not.toMatch(/(>|")[^<>"]*blackboard/i);
    }
  });
});
