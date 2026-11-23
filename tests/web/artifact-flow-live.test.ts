/**
 * 工件序列「在跑」标记 + 详情抽屉宽度 —— 接线哨兵(2026-11-22)
 *
 * ── 这份测试守的是什么 ────────────────────────────────────────────
 *
 * 用户诉求:「在工件里面体现正在运行的情况;工件的详情页面可以更大一点。」
 *
 * 「在跑」的判据**早已存在**(`lib/workGraph.ts` 的 `workRunningState`,工作项页
 * DAG 在用),所以这里的腐坏风险不是判据错,而是:
 *   ① 页面上**另起一套判据**(直接摸 `turn !== null` / `status === "in_progress"`)
 *      —— 同一件事两种说法,与实体脊守的是同一条纪律;
 *   ② 取数接了但**出错时不降级** —— 拿旧快照点亮呼吸点,把过去冒充现场;
 *   ③ 「读不到」被渲染成「没在跑」(灰点分支被顺手删掉)。
 *
 * 抽屉宽度:`.ss-inspector` 480 → 680(2026-11-22)—— 工件正文(html_report)
 * 是抽屉的主要读者对象;这条钉住宽度字面量,防「顺手改回去」。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (rel: string): string =>
  readFileSync(resolve(__dirname, "../../web/src", rel), "utf8");

describe("工件序列:「在跑」标记与详情抽屉", () => {
  const flow = source("features/artifacts/ArtifactFlow.tsx");
  const css = source("styles/globals.css");

  it("① 「在跑」判据与工作项页同源 —— 走 workRunningState,不写第二套", () => {
    // ⚠️ 钉的是**调用点**而不是标识符 —— 只查 `workRunningState` 会被 import
    // 语句喂饱(变异实测 M1 漏网过:删调用换手写,断言照样绿)。
    expect(flow).toContain("workRunningState(work, live)");
    // 不许在页面里另起判据(那会是第二个真相):这两条是判据的血肉,
    // 只该活在 workGraph.ts 里。
    expect(flow).not.toMatch(/turn\s*!==\s*null/);
    expect(flow).not.toMatch(/status\s*===\s*"in_progress"/);
  });

  it("② 运行态取数真的接了(useProjectLive),出错按「读不到」降级", () => {
    expect(flow).toContain("useProjectLive(effectiveProjectId)");
    // 与 Works.tsx 同一行纪律:live 出错 ⇒ null ⇒ workRunningState 给 unknown,
    // 不拿旧快照点亮呼吸点。
    expect(flow).toContain("liveLoad.error === null ? liveLoad.data : null");
  });

  it("③ 读得到 ⇒ 呼吸点 +「在跑」;读不到 ⇒ 灰点、不带字(两边都不冒充)", () => {
    // 只在 running 时发标记(没有 workId / 找不到工作项 ⇒ 没有标记,不是「没在跑」)
    expect(flow).toContain("run !== null && run.running");
    // 灰点分支:unknown 时 data-state 换灰、文字不出现
    expect(flow).toContain('data-state={run.unknown ? "unknown" : undefined}');
    expect(flow).toContain('!run.unknown && "在跑"');
  });

  it("④ 工件详情抽屉 680px(工件正文是主要读者对象,480 读起来挤)", () => {
    expect(css).toContain("width: min(680px, 94vw);");
  });
});
