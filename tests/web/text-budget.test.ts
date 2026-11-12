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
 *   重构前 9,809 字 → 重构后 9,384 字(-425)。
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
  "components/chat/ChatComposer.tsx": 154,
  "components/chat/ChatSurface.tsx": 317,
  "components/chat/Markdown.tsx": 0,
  "components/chat/MessageList.tsx": 119,
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
  "components/members/AgentConversations.tsx": 271,
  "components/members/RoleHarness.tsx": 1051,
  "components/members/ToolTable.tsx": 84,
  "components/relations/RelationsRail.tsx": 9,
  "components/settings/SettingsPanel.tsx": 343,
  "components/shell/AgentPanel.tsx": 61,
  "components/shell/ChatRightRail.tsx": 0,
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
  "lib/dashboard.ts": 335,
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
  "routes/Memory.tsx": 382,
  "routes/ProjectDetail.tsx": 719,
  "routes/Works.tsx": 1527,
  "stores/chat.ts": 111,
  "stores/settings.ts": 0,
};

const TOTAL_BASELINE = Object.values(BASELINE).reduce((a, b) => a + b, 0);

describe("可见文字预算:屏上的中文只许减不许增", () => {
  it("① 每个文件 ≤ 基线,总量 ≤ 9384", () => {
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
    expect(total).toBeLessThanOrEqual(9384);
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
