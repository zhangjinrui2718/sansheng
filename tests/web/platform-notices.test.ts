/**
 * 平台通知的**分类与落点**(本轮改动)
 *
 * ── 这一批把「平台通知」从对话记录里搬走,判据有三条 ─────────────────
 *
 *   1. **类**:`session_messages` 里 `kind = 'system'` 的行只有两个生产者
 *      (`serve.ts` 的 `announceDrain` / `reportUnannouncedTurn`),它们分别是
 *      「停止推进」(项目级)与「合规告警」(回合级)。分类只认**首行前缀** ——
 *      正文中段引用了这几个字样的记录不该被改判(下面有负样本)。
 *   2. **收集**:只有 `kind === "system"` 算平台通知。同一条正文出现在助手消息里,
 *      那是某个角色在**谈论**这件事,不是平台在报这件事(负样本)。
 *   3. **落点**:全文落在项目页的「组织运行态」卡;对话页的系统带只剩一行摘要,
 *      正文**仍在 DOM 里、默认折叠** —— 7-N:「一份证据被折叠可以,被删掉不行」。
 *
 * ⚠️ 两条正样本是**真机库原文**(`~/.sansheng/sansheng.db` 的 `session_messages`),
 * 逐字抄来不做改写:判据就是照着它们写的,改成「像真的」的句子等于把测试变成自证。
 *
 * ── 为什么这样测 ────────────────────────────────────────────────
 *
 * 与 `tests/web/channel-filter.test.ts` 同一形态:判据抽在纯函数里直测,渲染抽在
 * `ConversationStream`(纯 props)上用 `renderToStaticMarkup` —— `MessageList`
 * 从 zustand 取数,而 SSR 下 store 读的是 server snapshot,驱动不了。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMessageView } from "@shared/types/platform";
import { ConversationStream } from "@/components/chat/MessageList";
import {
  classifyPlatformNotice,
  collectPlatformNotices,
  platformNoticeLabel,
} from "@/lib/platformNotices";
import type { Turn } from "@/stores/chat";

/** 真机原文①:排空撞上单次回合上限(项目 pj_muv0ige6jgvbdtco)。 */
const REAL_STOP =
  "⚠️ 组织停止推进(8 个回合后):已达单次排空上限 8 个 agent 回合,仍有待办没跑完 —— " +
  "已停下(不是静默停:这条会广播并落库)\n" +
  "本轮路径:pm → wk → wk → pm → wk → wk → pm → qa";

/** 真机原文②:平台叫醒的回合没留工作记录(同项目,回合 msg_muv1q716bl1xp8ve)。 */
const REAL_COMPLIANCE =
  "⚠️ 平台检测:平台叫醒的回合没留工作记录(未调 tell_client,正文也没有行首标记)\n" +
  "项目 pj_muv0ige6jgvbdtco · bm · 回合 msg_muv1q716bl1xp8ve\n" +
  "待办类别 report_downstream;成功投递的 tell_client 0 次(共调用 0 次);收尾时项目级未消费事件 4 条\n" +
  "正文前 120 字:[工作记录] 平台叫醒我,带来一条 critical 阻塞(部署形态决策过时)+ " +
  "已交付完成的根工作项。需要先查清楚:阻塞是在交付前还是交付后出现的," +
  "是不是已经实质影响刚交付的那份方案。[未播报] 评估 3 类事件 ——\n\n① **[cri";

/** 收集函数的输入形态(与 `SessionMessageView` 的那几列同形)。 */
function msg(
  id: string,
  kind: SessionMessageView["kind"],
  content: string,
  createdAt: number,
): Pick<SessionMessageView, "id" | "kind" | "content" | "createdAt"> {
  return { id, kind, content, createdAt };
}

describe("平台通知 · 分类(只认首行前缀)", () => {
  it("正样本:真机两条原文各归其类", () => {
    expect(classifyPlatformNotice(REAL_STOP)).toBe("stop");
    expect(classifyPlatformNotice(REAL_COMPLIANCE)).toBe("compliance");
  });

  it("负样本:同一句话出现在**正文中段**不算「停止推进」", () => {
    // 行首判据,不是包含 —— 与 `[未播报]` 的分流判据同一条纪律
    expect(classifyPlatformNotice("复盘:上次那条 ⚠️ 组织停止推进 是因为上限太低")).toBe("other");
    expect(classifyPlatformNotice("\n⚠️ 组织停止推进(8 个回合后):…")).toBe("other");
  });

  it("负样本:认不出来的 system 文本退化成「平台通知」,不猜", () => {
    expect(classifyPlatformNotice("")).toBe("other");
    expect(classifyPlatformNotice("服务重启完成")).toBe("other");
  });

  it("类名不带 emoji / 括号解释(与角色名同一条 UI 纪律)", () => {
    expect(platformNoticeLabel("stop")).toBe("停止推进");
    expect(platformNoticeLabel("compliance")).toBe("合规告警");
    expect(platformNoticeLabel("other")).toBe("平台通知");
  });
});

describe("平台通知 · 收集", () => {
  it("⚠️ 只认 `kind === 'system'`:同一条正文出现在助手消息里**不算**", () => {
    const rows = [
      msg("m-sys", "system", REAL_STOP, 200),
      msg("m-bm", "assistant", REAL_STOP, 100),
    ];
    const n = collectPlatformNotices(rows);
    expect(n.total, "助手消息不是平台在报这件事").toBe(1);
    expect(n.all.map((x) => x.id)).toEqual(["m-sys"]);
  });

  it("新的在前;正文**逐字**带着(不解析、不截断)", () => {
    const rows = [
      msg("m-old", "system", REAL_COMPLIANCE, 100),
      msg("m-new", "system", REAL_STOP, 200),
      msg("m-user", "user", "甲方说的话", 300),
    ];
    const n = collectPlatformNotices(rows);
    expect(n.all.map((x) => x.id)).toEqual(["m-new", "m-old"]);
    expect(n.stops.map((x) => x.id)).toEqual(["m-new"]);
    expect(n.compliance.map((x) => x.id)).toEqual(["m-old"]);
    expect(n.all[1]!.content).toBe(REAL_COMPLIANCE);
  });

  it("空输入 = 空结果(页面据此显示空态,不摆 0 占位)", () => {
    const n = collectPlatformNotices([]);
    expect(n.total).toBe(0);
    expect(n.all).toEqual([]);
  });
});

describe("对话页 · 系统带只剩一行摘要", () => {
  /** 平台通知那一轮的形态(role=system ⇒ `channelOf` 第 1 步就摘进系统带)。 */
  function sysTurn(id: string, text: string): Turn {
    return {
      id,
      projectId: "p-test",
      role: "system",
      agentId: null,
      blocks: [{ kind: "text", text }],
      startedAt: 0,
      origin: { source: "unknown" },
    };
  }

  it("摘要行给出类名与去向;正文默认折叠但**仍在 DOM 里**", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStream, {
        history: [{ turn: sysTurn("s1", REAL_STOP), channel: "system" }],
        streaming: [],
        hiddenNote: null,
      }),
    );
    // 带子还在(既有判据:平台通知不冒充任何人的气泡)
    expect(html).toContain('data-channel="system"');
    // 摘要:类名 + 去向
    expect(html).toContain("停止推进");
    expect(html).toContain("全文在「项目」页");
    // 折叠:是 `<details>`,而且**没有 open**
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    // 7-N:折叠不是删除 —— 正文一个字都没少(含路径那一行)
    expect(html).toContain("本轮路径:pm → wk → wk → pm → wk → wk → pm → qa");
  });

  it("合规告警走同一形态,类名不同", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStream, {
        history: [{ turn: sysTurn("s2", REAL_COMPLIANCE), channel: "system" }],
        streaming: [],
        hiddenNote: null,
      }),
    );
    expect(html).toContain("合规告警");
    expect(html).toContain("msg_muv1q716bl1xp8ve");
  });
});
