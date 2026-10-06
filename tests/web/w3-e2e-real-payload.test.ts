/**
 * W3-③ · **实机载荷回放** —— 一条真回合的消息,经真前端判据之后落到哪条通道
 *
 * ── 这份夹具是什么(以及为什么它不是手搓的)────────────────────────
 *
 * `.probe/w3-e2e-messages.json` 是 **2026-10-05 从真宿主上抓下来的原样响应**
 * (`GET /api/projects/p_e2e_1791183049956/messages`,服务跑在 `--data <副本>` 上、
 * provider = 真 minimax-cn/MiniMax-M3)。里面那两条业务经理的正文是**真模型**写的,
 * 触发是**真排空器**给的(`report_downstream`),`origin` 是**真落库**的那两列。
 *
 * 手搓夹具证明不了的东西,这份能证明:**判据在实机载荷上的结论**。
 *
 * ── 它钉住的三件事 ──────────────────────────────────────────────
 *
 *   1. **W3-① 的闭合**(`fix(origin)`):REST 回来的 `SessionMessageView.origin`
 *      **照抄**库里的封套 ⇒ 两条「平台叫醒业务经理」的回合被判进 `internal`
 *      ⇒ **它们不进对话页**(前缀 `h-` 的那两条把手搓夹具证明过一遍,这里证明
 *      它在真载荷上同样成立)。⚠️ 夹具里业务经理**是** `clientFacing` —— 正是
 *      这一点让「按角色两跳」的回退判据会放它进来,所以这条断言有牙。
 *   2. **平台告警那两条**(`kind='system'`)落在系统带,不是甲方气泡
 *      (`agentId === null` **不等于**甲方 —— §2.10.1)。
 *   3. **A4 的 `splitWorkLog` 在真正文上不触发** —— 真模型把 `[未播报]` 写在了
 *      **第 3 行的行中**,不是行首(`^[未播报]`)。这条**不是**代码 bug(平台与界面
 *      的行首判据一致,`serve.ts` 与 `MessageList.tsx` 都按行 split),而是
 *      **提示词层面的合规失败**:下面是**正样本对照** —— 同一段正文,只把标记挪到
 *      行首,分流立刻成立。
 *
 * ⚠️ 载荷缺失时整组**跳过**(`.probe/` 在仓库里,但 CI/别的机器上可能没有)。
 * 跳过是显式的,不是「悄悄变成 0 个用例还能绿」——`skipIf` 会在报告里写出 skipped。
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberView, SessionMessageView } from "@shared/types/platform";
import {
  channelContextOf, partitionTurns,
} from "@/lib/data";
import { splitWorkLog } from "@/components/chat/MessageList";
import { useChatStore, type Turn } from "@/stores/chat";

const MESSAGES = join(process.cwd(), ".probe", "w3-e2e-messages.json");
const MEMBERS = join(process.cwd(), ".probe", "w3-e2e-member-conversations.json");
const present = existsSync(MESSAGES) && existsSync(MEMBERS);

const PROJECT = "p_e2e_1791183049956";

interface MessagesBody {
  projectId: string;
  messages: SessionMessageView[];
}
interface MemberBody {
  groups: Array<{ agentId: string | null; messages: SessionMessageView[] }>;
}

const load = <T,>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

/** 判据输入:成员表 + 「谁面向甲方」。**业务经理是 clientFacing** —— 回退判据会放它进来。 */
const MEMBER_VIEWS: MemberView[] = [
  { id: "bm", role: "business_manager", displayName: "业务经理", specialization: null },
  { id: "wk", role: "worker", displayName: "工程师", specialization: "engineering" },
];
const CTX = channelContextOf({
  members: MEMBER_VIEWS,
  roles: [
    { role: "business_manager", clientFacing: true },
    { role: "project_manager", clientFacing: false },
    { role: "worker", clientFacing: false },
    { role: "quality_reviewer", clientFacing: false },
  ],
  ready: true,
  intake: false,
});

describe.skipIf(!present)("W3-③ 实机载荷回放:真回合 → 真判据", () => {
  /** 走**真** `selectProject` → 真 `messageToTurn`(不是在这里重写一遍映射)。 */
  async function loadThroughStore(): Promise<Turn[]> {
    const body = load<MessagesBody>(MESSAGES);
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("/api", "");
      // ⚠️ sessions 那一支(migration 024):`selectProject` 先列会话再拉那条线的消息
      // ⚠️ `messages` 用 `startsWith` 而不是 `===`:它现在带 `?sessionId=`
      // (migration 024)。等于匹配会让这个夹具**静默地**什么都不返回 ——
      // 而那个表现是「回填的消息一条都没有」,不像一个路径匹配写错了。
      const payload = path.startsWith(`/projects/${PROJECT}/messages`)
        ? body
        : path === `/projects/${PROJECT}/sessions`
          ? { projectId: PROJECT, sessions: [{ id: "s_main", kind: "main", title: null,
              channel: "internal", deliverableArtifactId: null, createdAt: 0, lastMessageAt: 1 }] }
          : {};
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(payload) };
    });
    try {
      await useChatStore.getState().selectProject(PROJECT);
    } finally {
      vi.unstubAllGlobals();
    }
    return useChatStore.getState().turns;
  }

  it("夹具自检:载荷里**确实**有两条真模型写的业务经理正文 + 两条平台告警", () => {
    const { messages } = load<MessagesBody>(MESSAGES);
    // 非空断言:夹具一旦被清空/换掉,下面的判据就是空转
    const bm = messages.filter((m) => m.agentId === "bm" && m.kind === "assistant");
    const sys = messages.filter((m) => m.kind === "system");
    expect(bm.length, "真回合的助手消息必须 ≥2 条").toBeGreaterThanOrEqual(2);
    expect(sys.length, "平台告警必须 ≥2 条(两 arm 各一条)").toBeGreaterThanOrEqual(2);
    // 正样本:其中至少一条正文里**出现过** `[未播报]` 这五个字
    expect(bm.some((m) => m.content.includes("[未播报]")), "真正文里必须出现过这五个字").toBe(true);
  });

  it("① origin 照抄库里的封套:两条业务经理回合都是 {turn, todo} —— **不是 unknown**", async () => {
    const turns = await loadThroughStore();
    const bm = turns.filter((t) => t.agentId === "bm");
    expect(bm.length).toBeGreaterThanOrEqual(2);
    for (const t of bm) {
      expect(t.origin).toEqual({ source: "turn", trigger: { kind: "todo" } });
    }
    // 负样本:W3-① 修之前这里是 `unknown` ⇒ 回退判据会把它们放行
    expect(bm.some((t) => t.origin.source === "unknown")).toBe(false);
  });

  it("② 两条业务经理回合**不进对话页** —— 尽管业务经理是 clientFacing", async () => {
    const turns = await loadThroughStore();
    const { timeline, hidden } = partitionTurns(turns, CTX);
    const bmIds = turns.filter((t) => t.agentId === "bm").map((t) => t.id);
    expect(bmIds.length).toBeGreaterThanOrEqual(2);
    for (const id of bmIds) {
      expect(timeline.map((x) => x.turn.id), `回合 ${id} 不该出现在甲方时间线`).not.toContain(id);
    }
    // 平台告警落在系统带(不是「hidden」,也不是甲方气泡)
    expect(timeline.every((x) => x.channel === "system"), "实机载荷里进对话页的只有系统通知").toBe(true);
    expect(hidden, "被滤掉的正是那两条 todo 回合").toBe(bmIds.length);
  });

  it("③ A4 在真正文上**不**触发(标记写在第 3 行行中),而行首化之后就触发", async () => {
    const { messages } = load<MessagesBody>(MESSAGES);
    const withMarker = messages.find((m) => m.content.includes("[未播报]"));
    expect(withMarker, "夹具里必须有一条含标记的正文").toBeDefined();
    const text = withMarker!.content;

    // 实机正文:只有 speech 一段 —— 因为 `[未播报]` **不在行首**(它在第 3 行行中)
    const segments = splitWorkLog(text);
    expect(segments.every((s) => s.kind === "speech"), "真正文里那五个字是行中的,不该被分流").toBe(true);
    const markerLine = text.split("\n").find((l) => l.includes("[未播报]"))!;
    expect(markerLine.startsWith("[未播报]"), "实机现场:标记**不在**行首").toBe(false);

    // 正样本对照:同一段正文,只把标记挪到那一行的行首 ⇒ 分流立刻成立
    const fixedLine = markerLine.replace("[未播报]", "").trimStart();
    const fixedText = text.replace(markerLine, `[未播报] ${fixedLine}`);
    const fixed = splitWorkLog(fixedText);
    expect(fixed.some((s) => s.kind === "work_log"), "行首化之后必须被识别成工作记录").toBe(true);
  });

  it("成员页那条读路同样带 origin(显式列名的那条 SQL)", () => {
    const body = load<MemberBody>(MEMBERS);
    const bm = body.groups.find((g) => g.agentId === "bm");
    expect(bm, "成员页必须有 bm 组").toBeDefined();
    const withOrigin = (bm?.messages ?? []).filter((m) => m.origin.source === "turn");
    expect(withOrigin.length, "成员页里 bm 的回合消息必须带 turn 封套").toBeGreaterThanOrEqual(2);
  });
});
