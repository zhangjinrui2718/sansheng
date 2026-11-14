/**
 * 可见文字预算 —— 「核心且简洁」的仪器(2026-11-12,Wave 6)
 *
 * ── 用户要的是什么(原话,paraphrased)──────────────────────────
 *
 * 「展示的信息需要核心且简洁,不要在 UI 上面堆大量的文字。」
 *
 * ⚠️ 这是**一句判据**,而一句判据没有仪器就一定会漂回去:每一次「顺手加一句
 * 说明」单看都合理,叠起来就是原来那堵墙。所以这一份测试把「屏上有多少中文」
 * 变成 **per-file ratchet**:只许减,不许增。
 *
 * ── 计数口径 ──────────────────────────────────────────────────
 *
 *   · 每个 `web/src` 的 `.ts/.tsx`,剥掉注释与 import 之后数中文字符;
 *   · 注释里的字不算(那是给读代码的人的,`annotation-budget.test.ts` 管屏上那部分);
 *   · **豁免两处**:`lib/glossary.ts`(出处/判据的唯一落点 —— 29 条逐条有
 *     `?` 读者,由 `annotation-budget` 判据 ⑤ 钉)与 `routes/About.tsx`
 *     (说明书的唯一落点,逐条内容由 `about-page.test.ts` 钉)。
 *     豁免 ≠ 不管:那两个文件的每一行都有**逐条**的测试,比这里的总量更严。
 *
 * ── 起点(2026-11-12,Wave 6 实测)────────────────────────────
 *
 *   Wave 6 前 9,809 → Wave 8 后 9,270 → Wave 9 登记两笔(设置页切换历史 +79、成本参考线 +22)。
 *   同时:悬停超集(模板 `title`)8 处超标全压进 ≤ 40 字
 *   (`annotation-budget.test.ts` 规则 ⑩);平台记录长正文默认夹紧
 *   (`ProjectDetail.NoticeBody`);确认弹窗长文案收进默认折叠的 Disclosure。
 *
 * 基线表是 ratchet:**把文字变短之后,请把对应数字改小**;任何一条变红都意味着
 * 有人往屏上加了一段没被斟酌过的字。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_SRC = join(process.cwd(), "web/src");

/** 与 `annotation-budget.test.ts` 同一条剥注释纪律(注释里的字不是屏上的字)。 */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n"'`]*$/gm, "$1")
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 出处/判据与说明书有它们自己的家 —— 这两处的字量由逐条测试管,不在这里管。 */
const EXEMPT = new Set(["lib/glossary.ts", "routes/About.tsx"]);

const cjkCount = (s: string): number => (s.match(/[\u4e00-\u9fff]/g) ?? []).length;

/** 基线(2026-11-12,Wave 6 收口后的实测值;只许往下改)。 */
const BASELINE: Record<string, number> = {
  "App.tsx": 18,
  "components/brand/Seal.tsx": 2,
  "components/chat/ChatComposer.tsx": 136,
  "components/chat/ChatSurface.tsx": 317,
  "components/chat/Markdown.tsx": 0,
  "components/chat/MessageList.tsx": 103,
  "components/chat/ThinkingBlock.tsx": 25,
  "components/chat/ToolCallCard.tsx": 0,
  "components/client/AcceptanceDock.tsx": 97,
  "components/client/ClientQuestionCard.tsx": 91,
  "components/client/ClientQuestionDock.tsx": 125,
  "components/dashboard/DashboardCards.tsx": 17,
  "components/deliverable/CodeService.tsx": 484,
  "components/deliverable/ContentDriftNote.tsx": 30,
  "components/deliverable/DeliveryVerdictActions.tsx": 276,
  "components/deliverable/HtmlReport.tsx": 113,
  "components/members/AgentConversations.tsx": 256,
  // 2026-11-14:1051 → 332。编辑器 / 纯判据 / 告警与工具面段落 / 有状态工作台
  // 搬去 `components/harness/`(那边逐文件登记),本文件只剩成员页那张卡的形状
  // 与入口链接 —— 是搬家,不是删文案。
  "components/members/RoleHarness.tsx": 332,
  "components/members/ToolTable.tsx": 84,
  // ── 2026-11-14:「Harness 管理」(routes/HarnessManage.tsx)把可复用件抽成
  //    components/harness/ 四份 —— 逐文件登记:
  //    judgments 144(纯判据,大部分是从 RoleHarness 搬来的措辞)+ PromptUnitEditor
  //    395(编辑器,逐字搬来)+ Blocks 265(告警 / 工具面 / 常量,逐字搬来;
  //    净新增的是「路径 / allow / deny」三行与「直接编辑文件」一句 —— 旧版这些
  //    信息在悬停里,现在摆上看得见的地方)+ 工作台 0。
  "components/harness/Blocks.tsx": 265,
  "components/harness/PromptUnitEditor.tsx": 395,
  "components/harness/judgments.ts": 144,
  "components/harness/useHarnessWorkspace.ts": 0,
  //    HarnessManage 139:新页面的屏上字数(段落标题 / 全局状态 / 左列与三段骨架;
  //    状态词全部来自共享判据,这里没有第二套)。四项合计 +245 = 总量基线的增量。
  "routes/HarnessManage.tsx": 139,
  "components/relations/RelationsRail.tsx": 9,
  // 2026-11-13:供应商切换历史折叠段(343 → 397,+54,逐项斟酌过:摘要 9 +
  // 空态 17 + kind 标签 8 + `what` 4 + 「审计聚合,非结构化遥测」一句 16)。
  // 新功能计入基线,不是放水 —— 那一句注释性文案已压到最短。
  "components/settings/SettingsPanel.tsx": 397,
  "components/shell/AgentPanel.tsx": 52,
  "components/shell/ChatRightRail.tsx": 9,
  "components/shell/EntityInspector.tsx": 8,
  "components/shell/HistoryRail.tsx": 255,
  "components/shell/TopBar.tsx": 37,
  "components/ui/DataState.tsx": 14,
  "components/ui/Help.tsx": 12,
  "components/ui/MetadataStrip.tsx": 0,
  "components/ui/primitives.tsx": 0,
  "lib/api.ts": 0,
  "lib/appSocket.ts": 0,
  "lib/artifactGraph.ts": 274,
  "lib/dashboard.ts": 357,
  "lib/data.ts": 82,
  "lib/deepLink.ts": 0,
  "lib/deliverable.ts": 2,
  "lib/entityMeta.ts": 143,
  "lib/knowledgeState.ts": 210,
  "lib/markdown.ts": 0,
  "lib/orgState.ts": 345,
  "lib/platformNotices.ts": 22,
  "lib/questionScope.ts": 0,
  "lib/relations.ts": 107,
  "lib/route.ts": 0,
  "lib/scroll.ts": 0,
  "lib/timeline.ts": 17,
  "lib/vocab.ts": 168,
  "lib/workGraph.ts": 0,
  "lib/ws.ts": 0,
  "main.tsx": 0,
  "routes/Members.tsx": 927,
  "routes/Memory.tsx": 358,
  "routes/ProjectDetail.tsx": 678,
  "routes/Works.tsx": 1527,
  "stores/chat.ts": 111,
  "stores/settings.ts": 0,
};

const TOTAL_BASELINE = Object.values(BASELINE).reduce((a, b) => a + b, 0);

describe("可见文字预算:屏上的中文只许减不许增", () => {
  it("① 每个文件 ≤ 基线,总量 ≤ 9346", () => {
    const over: string[] = [];
    let total = 0;
    for (const abs of walk(WEB_SRC)) {
      const rel = abs.slice(WEB_SRC.length + 1);
      if (EXEMPT.has(rel)) continue;
      const n = cjkCount(stripComments(readFileSync(abs, "utf8")));
      total += n;
      const cap = BASELINE[rel];
      if (cap === undefined) {
        over.push(`${rel}: 基线表里没有这个文件 —— 新文件要登记进 BASELINE`);
      } else if (n > cap) {
        over.push(`${rel}: ${n} > 基线 ${cap}(+${n - cap})`);
      }
    }
    expect(over.join("\n")).toBe("");
    // 2026-11-13:9,270 → 9,346(+76,供应商切换历史折叠段;明细见 BASELINE 那条)
    // 2026-11-14:9,346 → 9,591(+245,全部来自「Harness 管理」:新页面 +139,
    // 共享 ToolSurface 把旧悬停里的路径 / allow / deny 摆上看得见的地方 +106;
    // 其余都是搬家(RoleHarness −719 在四个新文件里原样记账),明细见 BASELINE)
    expect(total).toBeLessThanOrEqual(9591);
  });

  it("② 基线表覆盖所有文件(不许有文件悄悄逃出仪器)", () => {
    const walked = walk(WEB_SRC)
      .map((abs) => abs.slice(WEB_SRC.length + 1))
      .filter((rel) => !EXEMPT.has(rel))
      .sort();
    const registered = Object.keys(BASELINE).sort();
    expect(registered).toEqual(walked);
  });

  it("③ 自检:计数器对已知样本必须命中(否则 ① 是假绿)", () => {
    expect(cjkCount(stripComments("const a = 1; // 注释不算"))).toBe(0);
    expect(cjkCount(stripComments("return <p>这一句在屏上</p>;"))).toBe(6);
    expect(cjkCount(stripComments("/* 块注释也不算 */ const b = \"屏上\";"))).toBe(2);
  });

  it("④ 自检:豁免是真的豁免(改了豁免清单要过这两条)", () => {
    expect(EXEMPT.has("lib/glossary.ts")).toBe(true);
    expect(EXEMPT.has("routes/About.tsx")).toBe(true);
    // 豁免的两个文件确实存在 —— 名字写错会让豁免变成「没人管」。
    expect(walk(WEB_SRC).some((a) => a.endsWith("lib/glossary.ts"))).toBe(true);
    expect(walk(WEB_SRC).some((a) => a.endsWith("routes/About.tsx"))).toBe(true);
  });
});
