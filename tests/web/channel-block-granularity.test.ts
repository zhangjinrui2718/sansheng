/**
 * 通道判据的**粒度**:`channelOf` 按**轮**判(作者身份),不按**块**判 (2026-10-05 取证)
 *
 * ── 这份文件钉的是一个**缺口**,不是一条设计 ─────────────────────────
 *
 * 用户报告:「这些对话过程不需要展示在和我对话的框里面」。他贴出的那串
 * `⚙ meeting_read → meeting_respond → ask_client → blocker_read ×2 → project_read
 * → tell_client → board_write` **全部是业务经理自己调的工具**(真机 SDK 转录
 * `~/.sansheng/agent/sessions/--Users-fuyao-sansheng-workspace--/2026-10-05T01-11-08-352Z_*.jsonl`
 * 里,那一轮的角色行是「你是:业务经理(`business_manager`)」;而 `ask_client` /
 * `tell_client` **只出现在业务经理的 ceiling 里**,worker / pm / qa 都拿不到)。
 *
 * 那它们为什么看得见?因为 `channelOf` 的输入是 **`Turn`**(= 一条 messageId),
 * 而一轮的 `blocks` 里**同时装着**思考块、工具卡、正文 —— 判据一旦把这个轮判成
 * `client`(作者 `clientFacing`),**整轮的所有块**一起进甲方时间线。
 *
 *     Turn{ agentId:"bm", blocks:[thinking, tool(meeting_read), …, text] }
 *       └─ channelOf 只看 agentId ──→ "client" ──→ 全部块进 timeline
 *
 * 这是**设计缺口**(过滤粒度 = 角色级),不是实现 bug —— 所以这里的断言写的是
 * **今天的行为**。谁把粒度改细(按块 / 按工具 / 按回合触发来源),就必须同时改
 * 这份文件与 `docs/DESIGN-PLATFORM.md` §2.10.4/§2.12 —— 不许默默把它改绿。
 *
 * 正负样本(本项目纪律):
 *   · 正样本 —— 业务经理的轮(带工具卡)必须 `client` 且在 timeline;
 *   · 正样本 —— worker 的轮(同样带工具卡)必须 `internal` 且在 hidden;
 *   · 负样本 —— **把 blocks 换掉不改变通道**:判据里没有块的位置。
 */
import { describe, expect, it } from "vitest";
import type { MemberView, ProjectRole } from "@shared/types/platform";
import { channelContextOf, channelOf, partitionTurns, type ChannelContext } from "@/lib/data";
import type { Turn } from "@/stores/chat";

const MEMBERS: MemberView[] = [
  { id: "bm", role: "business_manager", displayName: "业务经理", specialization: null },
  { id: "pm", role: "project_manager", displayName: "项目经理", specialization: null },
  { id: "wk", role: "worker", displayName: "工程师", specialization: "engineering" },
  { id: "qa", role: "quality_reviewer", displayName: "质检", specialization: null },
];

const ROLES: Array<{ role: ProjectRole; clientFacing: boolean }> = [
  { role: "business_manager", clientFacing: true },
  { role: "project_manager", clientFacing: false },
  { role: "worker", clientFacing: false },
  { role: "quality_reviewer", clientFacing: false },
];

const CTX: ChannelContext = channelContextOf({
  members: MEMBERS,
  roles: ROLES,
  ready: true,
  intake: false,
});

/**
 * 一轮 = 思考块 + N 张工具卡 + 正文,与 `bridge()` 真实装配出的形状同形
 * (`host/serve.ts`:`tool_start` 带的是**本回合那个 messageId**,所以工具卡落进
 * 同一个 `Turn` 的 `blocks`;`thinking_delta` 同理)。
 */
function toolTurn(id: string, agentId: string, tools: readonly string[]): Turn {
  return {
    id,
    projectId: "p-test",
    role: "assistant",
    agentId,
    blocks: [
      { kind: "thinking", text: "让我先看一下这个会议的详情" },
      ...tools.map((name, i) => ({
        kind: "tool" as const,
        tool: { id: `${id}-t${i}`, name },
      })),
      { kind: "text", text: "已处理:…" },
    ],
    startedAt: 0,
  };
}

/** 用户真机上看到的那两轮(工具名逐字来自真转录)。 */
const BM_TURN_1 = toolTurn("msg_bm_1", "bm", ["meeting_read", "meeting_respond", "ask_client"]);
const BM_TURN_2 = toolTurn("msg_bm_2", "bm", [
  "blocker_read",
  "blocker_read",
  "project_read",
  "tell_client",
  "board_write",
]);
/** worker 的一轮(真转录 `2026-10-05T01-14-23-653Z_*.jsonl` 的同形)。 */
const WK_TURN = toolTurn("msg_wk_1", "wk", ["project_read", "blocker_open", "board_write"]);

describe("通道判据的粒度:按轮,不按块(取证固化)", () => {
  it("业务经理的轮(含 5 张工具卡)整轮进 timeline —— 工具卡跟着一起进", () => {
    const { timeline, hidden } = partitionTurns([BM_TURN_1, BM_TURN_2], CTX);
    expect(hidden).toBe(0);
    expect(timeline.map((x) => x.turn.id)).toEqual(["msg_bm_1", "msg_bm_2"]);
    // **这一条就是缺口**:进 timeline 的那一轮,blocks 里仍然有工具卡与思考块。
    const kinds = timeline[0]!.turn.blocks.map((b) => b.kind);
    expect(kinds).toEqual(["thinking", "tool", "tool", "tool", "text"]);
  });

  it("worker 的轮(同样含工具卡)整轮被滤掉 —— 落在 hidden 那一侧", () => {
    const { timeline, hidden } = partitionTurns([WK_TURN], CTX);
    expect(timeline).toEqual([]);
    expect(hidden).toBe(1);
    expect(channelOf(WK_TURN, CTX)).toBe("internal");
  });

  it("负样本:blocks 换成什么,都不改变通道 —— 判据里没有块", () => {
    const bare: Turn = { ...BM_TURN_2, blocks: [{ kind: "text", text: "只有正文" }] };
    const withTools = BM_TURN_2;
    expect(channelOf(withTools, CTX)).toBe(channelOf(bare, CTX));
    // 反向:同一个 agent 的轮不会因为「有工具卡」而降级成 internal。
    expect(channelOf(withTools, CTX)).toBe("client");
    // 且 `partitionTurns` 的计数只看轮数,不看块数。
    expect(partitionTurns([withTools], CTX).hidden).toBe(partitionTurns([bare], CTX).hidden);
  });
});
