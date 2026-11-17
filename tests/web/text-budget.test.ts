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
  // 2026-11-17(IA v4 走检):317 → 329(+12,头部「详情」入口;placeholder 键位段删除)
  "components/chat/ChatSurface.tsx": 329,
  "components/chat/Markdown.tsx": 0,
  // 2026-11-17(D3):「计划」卡 —— 新 UI(目标/判据摘要 + 拆解清单 + 确认开工),
  // 逐句斟酌过;对照的减量:AgentPanel -52、ChatRightRail -9、HistoryRail -19、
  // ChatSurface -14、ProjectDetail -5(HistoryRail/ChatSurface/ProjectDetail 见各自条目)。
  "components/chat/PlanConfirmCard.tsx": 117,
    // 2026-11-17(文案裁决):103 → 128(+25,HiddenNotice 的落点指引移进悬停 ——
  // 屏上散文退场,指针保留在 title)
  "components/chat/MessageList.tsx": 128,
  "components/chat/ThinkingBlock.tsx": 25,
  "components/chat/ToolCallCard.tsx": 0,
  // 2026-11-17(D5):97 → 115(+18,验收卡的「查看」入口 —— 跳工件抽屉读正文;
  // 有了它,右栏表态不再需要先去工作项页找那件货)。
  // 2026-11-17(D6):91 → 202(+111,收口提议卡 —— intent="close" 的提问渲染成
  // 「同意收口 / 先不收」两个固定动作,替代自由文本框;这是新分支,不是原卡片的加厚)。
  // 2026-11-17(R-A 融合):两个 dock 合并为收件箱 —— AcceptanceDock(97)与
  // ClientQuestionDock(151)退役,Inbox 承载同一判据(类型徽章+动作)。
  "components/client/Inbox.tsx": 111,
  "components/client/ClientQuestionCard.tsx": 177,
  // 2026-11-17(F3):125 → 151(+26,「已答复 · 业务经理整理中」一行 + 判据注释
  // 进了 title;对照 S-A 的删减净下降)。
  "components/dashboard/DashboardCards.tsx": 17,
  "components/deliverable/CodeService.tsx": 484,
  "components/deliverable/ContentDriftNote.tsx": 30,
  "components/deliverable/DeliveryVerdictActions.tsx": 276,
  "components/deliverable/HtmlReport.tsx": 113,
  // 2026-11-17(IA v4 走检):256 → 239(描述句「只在实时流里看得见…」退场)
  "components/members/AgentConversations.tsx": 239,
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
  "components/harness/Blocks.tsx": 337,
  "components/harness/HistoryPanel.tsx": 41,
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
  // 2026-11-17(IA v4 走检):397 → 374(顶部描述句退场;cwd 帮助句压成缺省值)
  "components/settings/SettingsPanel.tsx": 374,
  // 2026-11-17(S-A):「本项目」块删除 —— AgentPanel.tsx(52)整个移除;
  // ChatRightRail 9 → 0(右栏不再有任何屏上文案)。净 -61。
  "components/shell/ChatRightRail.tsx": 0,
  "components/shell/EntityInspector.tsx": 8,
  "components/shell/HistoryRail.tsx": 255,
  // 2026-11-17(F1):37 → 56(+19,Σ 的口径悬停 —— 「本次连接以来;权威值在项目页成本段」,
  // 防止把会话内合计读成全历史)。
  "components/shell/TopBar.tsx": 55,
  "components/ui/DataState.tsx": 14,
  "components/ui/Help.tsx": 12,
  "components/ui/MetadataStrip.tsx": 0,
  "components/ui/primitives.tsx": 0,
  "lib/api.ts": 0,
  "lib/appSocket.ts": 0,
  "lib/artifactGraph.ts": 274,
  "lib/dashboard.ts": 357,
  // 2026-11-17(D2):82 → 169(+87,「项目此刻」的片段文案生成器 projectNowOf ——
  // 「X 在跑「环节」(N 分钟)/ 在等你 N / 阻塞 N / 还有 N 个角色在跑 / 运行态读不到」;
  // 判据与屏上措辞同层(与 orgState/liveHeadline 同一条先例),词表拆出去会变成两处)。
  // 2026-11-17(IA v4 走检):169 → 105(channelNoteText 短式 + projectNowOf 的 · 串退场)
  "lib/data.ts": 105,
  "lib/deepLink.ts": 0,
  "lib/deliverable.ts": 2,
    // 2026-11-17(D7):143 → 156(+13,环节面板的「质检 · 待质检」一格 ——
  // 只在 review_state = pending 时出现,none/done 是常态不上屏)。
  "lib/entityMeta.ts": 156,
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
  // 2026-11-17(S-F):358 → 364(+6,分段控件的三个标签「画像/碎片/语料」——
  // 三段收成分段控件后,标签是新 UI 的必需字;总量靠 S-A/S-C 的删减净下降)。
  "routes/Memory.tsx": 364,
  "routes/ProjectDetail.tsx": 678,
  // 2026-11-17(S-D):1527 → 1535(+8,视图切换的三个标签「推进/依赖/工件关系」——
  // 三图收成一画布后,切换标签是新 UI 的必需字;叠放的段落标题随之消失)。
  // 2026-11-17(R-C/R-D):1535 → 1262(默认依赖 DAG;TimelineLegend/WorkDagLegend
  // 静态图例退场,运行态说明名称式;DAG 节点增「待质检」标记)
  "routes/Works.tsx": 1262,
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
    // 2026-11-17(v3 波):9,704 → 10,011 → **9,425(文案裁决:界面只留功能名称)** ——
    // 空态名称化(23 处)、卡片脚注判据句退场(「这里点了才算数」「答案会落成」
    // 「每项完成后…」「确认之前不派工」)、channelNoteText 名称+计数化、
    // CodeService 五条 hint 名称式。
    // ⚠️ v3 §1.6 的 ≤7,500 目标**仍未达标**(差 1,925)—— 剩余大头是记录卡内的
    // why/行动行(组织推进的呈现判据,2026-10-07 兜底裁决的呈现面)与 CodeService
    // 技术事实;再压需要逐条裁决,留作下一波。
    expect(total).toBeLessThanOrEqual(9425);
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
