/**
 * 2026-10-07 真机事故 · `[未播报]` 的工作记录泄漏进甲方通道 —— 回归
 *
 * ── 事故现场 ────────────────────────────────────────────────────
 *
 * 项目「Mac 量化系统 dev/prod 隔离 + CI/CD 自动化方案」。业务经理被
 * `resume_client` 待办叫醒,照提示词的硬要求写了:
 *
 *     [未播报] 评估 1 条 —— ①[决策反转]「W2 选型前提错误…」…
 *
 *    工作记录:
 *    - **查了**:…`art_muxjtm7lkhfj9fl3`…
 *    - **判了**:…我前一轮违反了规约…
 *
 * 共 **1988 字**,后 1744 字全是内部记录(工件 id、阻塞处置、要通知谁重做)。
 *
 * 而 2026-10-06 给三类待办(`handover` / `report_downstream` / `resume_client`)
 * 开的**正文自动进甲方通道**那条规矩**,把它整条判成了 `client` ⇒ 甲方在对话页上
 * 读到了这段内部记录。
 *
 * ── 两条规矩为什么打架 ──────────────────────────────────────────
 *
 * | 规矩 | 出处 | 它说 |
 * |---|---|---|
 * | 三类待办的正文进甲方 | `CLIENT_FACING_TODO_KINDS` | 有话直说就会到甲方 |
 * | 平台叫醒的回合必须挂 `[未播报]` | `business_manager.core.md` | 没调 `tell_client` 就必须声明 |
 *
 * 两条**都照做的回合**里,模型于是把内部工作日志交到了甲方手上。
 *
 * ── 修法:让标记说话,而不是让平台猜 ────────────────────────────
 *
 * `[未播报]` 的字面意思就是「本回合没播」。它写在正文第一个块的行首时,是一句
 * **机器可判的声明** —— 与 `serve.ts` 的 `detectUnannouncedTurn`(第 ④ 步认同一
 * 个标记)是同一份语义的两端。现在读面认它:行首 ⇒ `internal`。
 *
 * ⚠️ **负样本是这份文件的另一半**:三类待办**没挂标记**时仍必须进甲方通道 ——
 * 否则就是 2026-10-06 那个「关键张力没到甲方」的事故复发。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { MemberView, ProjectRole, TurnTrigger } from "@shared/types/platform";
import {
  channelContextOf,
  channelOf,
  partitionTurns,
  WORK_LOG_LINE,
  turnIsWorkLog,
} from "@/lib/data";
import { splitWorkLog } from "@/components/chat/MessageList";
import { useChatStore, type Turn } from "@/stores/chat";

const P = "p-worklog";
const BM = "bm";

const MEMBERS: MemberView[] = [
  { id: "bm", role: "business_manager", displayName: "业务经理", specialization: null },
  { id: "wk", role: "worker", displayName: "工程师", specialization: "engineering" },
];
const ROLES: Array<{ role: ProjectRole; clientFacing: boolean }> = [
  { role: "business_manager", clientFacing: true },
  { role: "worker", clientFacing: false },
];
const CTX = channelContextOf({ members: MEMBERS, roles: ROLES, ready: true, intake: false });

/** 真机那条正文的形状(前两段足够复现;不把 1988 字抄进测试)。 */
const LEAKED = [
  "[未播报] 评估 1 条 —— ①[决策反转]「W2 选型前提错误:GitHub vs 实际 GitLab.com」:Q1 是。",
  "",
  "工作记录:",
  "- **查了**:`art_muxjtm7lkhfj9fl3` 正文、`award_thread`…",
  "- **判了**:我前一轮违反了规约 —— 没读答复正文就凭标题作答。",
  "- **未立即处置**(等甲方答后):提 `change_propose`、通知 wk 重做 W2。",
].join("\n");

beforeEach(() => {
  useChatStore.setState({
    projectId: P, intakeActive: false, turns: [], inFlight: {}, inFlightOrder: [],
    currentTurn: null, lastUserEchoId: null, currentUsage: { input: 0, output: 0 },
    status: "idle", sessions: [],
  });
});

/** 一份手工构造的轮(判据的输入只有 role / agentId / origin / blocks)。 */
function turn(
  agentId: string | null,
  trigger: TurnTrigger,
  text: string,
): Turn {
  return {
    id: "m1", projectId: P, sessionId: "s1",
    role: agentId === null ? "user" : "assistant",
    agentId,
    origin: { source: "turn", trigger },
    blocks: text === "" ? [] : [{ kind: "text", text }],
    startedAt: 1,
  };
}

describe("2026-10-07 · `[未播报]` 的工作记录不许进甲方通道", () => {
  it("真机剧本:`resume_client` + 行首 `[未播报]` ⇒ internal(修前是 client)", () => {
    const t = turn(BM, { kind: "todo", todoKind: "resume_client" }, LEAKED);
    // 前提自检:这条待办**确实**在「自动进甲方」那个集合里 —— 否则本测试测的不是那件事
    expect(channelOf(turn(BM, { kind: "todo", todoKind: "resume_client" }, "有话对甲方说。"), CTX))
      .toBe("client");
    // 真值:挂了标记 ⇒ 留内部
    expect(channelOf(t, CTX)).toBe("internal");
  });

  it("三类待办逐个成立(`handover` / `report_downstream` / `resume_client`)", () => {
    for (const k of ["handover", "report_downstream", "resume_client"] as const) {
      expect(channelOf(turn(BM, { kind: "todo", todoKind: k }, LEAKED), CTX)).toBe("internal");
    }
  });

  // ↓↓↓ 负样本:这一半保证修复没有把 2026-10-06 那个事故改回来
  it("⚠️ 负样本:三类待办**没挂**标记 ⇒ 仍然进甲方通道", () => {
    for (const k of ["handover", "report_downstream", "resume_client"] as const) {
      const t = turn(BM, { kind: "todo", todoKind: k }, "档位 live_aggressive 与 <$25k 不匹配,这个张力我得当面说清。");
      expect(channelOf(t, CTX)).toBe("client");
    }
  });

  it("⚠️ 负样本:标记出现在**文末/中段** ⇒ 仍然进甲方通道(那是引述或补充)", () => {
    const t = turn(
      BM,
      { kind: "todo", todoKind: "resume_client" },
      "先跟你说结论:W2 要重做。\n\n[未播报] 上面那句是对你说的话,这行只是我的记录。",
    );
    expect(channelOf(t, CTX)).toBe("client");
  });

  it("用户消息 / 甲方答复回合不受影响(它们本来就不该带标记)", () => {
    expect(channelOf(turn(null, { kind: "user" }, "然后呢"), CTX)).toBe("client");
    expect(channelOf(turn(BM, { kind: "user" }, "收到。"), CTX)).toBe("client");
  });

  it("工作人别的 todo 本来就不进甲方 —— 标记不改变这一点", () => {
    const t = turn("wk", { kind: "todo", todoKind: "execute_work" }, LEAKED);
    expect(channelOf(t, CTX)).toBe("internal");
  });

  it("`partitionTurns` 把它记进 hidden,而不是 timeline", () => {
    const parts = partitionTurns(
      [turn(null, { kind: "user" }, "怎么配 dev/prod"), turn(BM, { kind: "todo", todoKind: "resume_client" }, LEAKED)],
      CTX,
    );
    expect(parts.timeline).toHaveLength(1);
    expect(parts.hidden).toBe(1);
  });
});

describe("turnIsWorkLog · 判据只认**第一个正文块的首行**", () => {  it("行首(含前导空格/制表符)命中", () => {
    expect(turnIsWorkLog(turn(BM, { kind: "todo", todoKind: "resume_client" }, LEAKED))).toBe(true);
    expect(WORK_LOG_LINE.test("  [未播报] 评估 1 条。")).toBe(true);
    expect(WORK_LOG_LINE.test("\t[未播报] x")).toBe(true);
  });

  it("没有正文块 / 空正文 ⇒ 不是工作记录(不误判)", () => {
    expect(turnIsWorkLog(turn(BM, { kind: "todo", todoKind: "resume_client" }, ""))).toBe(false);
  });

  it("列表项 `- [未播报]` 不算行首(与提示词和 serve.ts 的判据一致)", () => {
    expect(WORK_LOG_LINE.test("- [未播报] 评估 1 条。")).toBe(false);
  });

  it("只认第一个正文块 —— 说话在前的轮不算工作记录", () => {
    const t: Turn = {
      ...turn(BM, { kind: "todo", todoKind: "resume_client" }, ""),
      blocks: [
        { kind: "text", text: "先跟你说结论:W2 要重做。" },
        { kind: "text", text: "[未播报] 这行只是我的记录。" },
      ],
    };
    expect(turnIsWorkLog(t)).toBe(false);
    expect(channelOf(t, CTX)).toBe("client");
  });
});

// ── 渲染侧(第二条泄漏路径)────────────────────────────────────────

describe("splitWorkLog · 以标记开头的正文,整条都是工作记录", () => {
  it("真机那条 1988 字:空行之后**不许**回到 speech(修前泄漏 1744 字)", () => {
    const segs = splitWorkLog(LEAKED);
    // 修前是 [work_log(242 字), speech(1744 字)] —— 那个 speech 就是甲方读到的内部记录
    expect(segs.map((s) => s.kind)).toEqual(["work_log"]);
    // 内容一个字符都不许丢(折叠 ≠ 删除)
    expect(segs[0]!.text).toContain("art_muxjtm7lkhfj9fl3");
    expect(segs[0]!.text).toContain("我前一轮违反了规约");
    expect(segs[0]!.text).toContain("通知 wk 重做 W2");
  });

  it("⚠️ 负样本:先说话、再记一条 ⇒ 仍然是 speech 开头(段级分流的原契约不变)", () => {
    const segs = splitWorkLog("先跟你说结论:W2 要重做。\n\n[未播报] 这行只是我的记录。");
    expect(segs.map((s) => s.kind)).toEqual(["speech", "work_log"]);
    expect(segs[0]!.text).toBe("先跟你说结论:W2 要重做。");
  });

  it("前导空行不影响判定(标记仍在第一行内容处)", () => {
    const segs = splitWorkLog("\n\n[未播报] 评估 1 条。\n\n工作记录:\n- 查了 X。\n");
    expect(segs.map((s) => s.kind)).toEqual(["work_log"]);
    expect(segs[0]!.text).toContain("查了 X");
  });
});
