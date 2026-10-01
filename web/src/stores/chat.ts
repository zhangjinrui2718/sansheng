/**
 * Sansheng Chat Store · Zustand
 *
 * 单一对话流(M1);M3+ 拆多会话。
 */
import { create } from "zustand";
import type { ServerEvent } from "@shared/types/ws";
import type { Block } from "@shared/types/chat";

export type Role = "user" | "assistant" | "system";

export type { Block };

export interface Turn {
  id: string;
  role: Role;
  blocks: Block[];
  startedAt: number;
  endedAt?: number;
  usage?: { input: number; output: number };
  isStreaming?: boolean;
  errorText?: string;
}

export type ChatStatus = "idle" | "streaming" | "error" | "connecting";

export interface ChatState {
  conversationId: string | null;
  modelId: string | null;
  provider: string | null;
  status: ChatStatus;
  kernelReady: boolean;
  /** 递增计数,HistoryRail useEffect 依赖它来重新拉取。 */
  historyRefreshTrigger: number;
  /** M3c: MessageBus 收到的全部 BusMessage 流(可被 Timeline 页订阅) */
  busStream: import("@shared/types/agents").BusMessage[];
  /** M3c: Communicator 当前状态 */
  communicatorStatus: "idle" | "thinking" | "tool_use";
  /** M3c: 当前阻塞中、Communicator 升级到用户的 pending question */
  pendingQuestions: import("@shared/types/agents").PendingQuestion[];
  /** M3c: 用户在 Timeline 输入的回答草稿,keyed by questionId */
  answerDraft: Map<string, string>;
  socket: unknown;
  turns: Turn[];
  currentTurn: Turn | null;
  currentUsage: { input: number; output: number; costUsd: number };
  totalUsage: { input: number; output: number; costUsd: number };
  error: { code: string; message: string } | null;

  reset(): void;
  applyEvent(e: ServerEvent): void;
  appendUserTurn(text: string): void;
  /** 在 ChatSurface 创建 socket 后调,让 store 能转发 WS 命令 */
  attachSocket(socket: { send(cmd: unknown): void } | null): void;
  /** M3a: 点历史时发 WS load_conversation 让 server resume */
  sendLoadConversation(conversationId: string): void;
  /** M3c: 用户回答 worker 的 pending question */
  sendAnswerQuestion(questionId: string, payload: string): void;
  /** M3c: 用户取消 worker 的 pending question */
  sendCancelQuestion(questionId: string): void;
  /** M3c: 设置 Timeline 输入框对某 question 的草稿 */
  setAnswerDraft(questionId: string, text: string): void;
  /** 新建对话:调后端 + 清本地状态 */
  newConversation(): Promise<void>;
  /** M2:从后端加载一个历史对话的快照(覆盖本地状态) */
  loadConversation(snapshot: ConversationSnapshot): void;
}

/** 从 /api/conversations/:id 返回的数据 */
export interface ConversationSnapshot {
  conversation: {
    id: string;
    title: string | null;
    cwd: string | null;
    modelId: string | null;
    provider: string | null;
    createdAt: number;
    lastActiveAt: number;
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  };
  messages: Array<{
    id: string;
    conversationId: string;
    turnIndex: number;
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCalls: string | null;
    thinking: string | null;
    usageInput: number;
    usageOutput: number;
    costUsd: number;
    createdAt: number;
  }>;
}

const newTurn = (id: string, role: Role): Turn => ({
  id,
  role,
  blocks: [],
  startedAt: Date.now(),
  isStreaming: false,
});

export const useChatStore = create<ChatState>((set, get) => ({
  conversationId: null,
  modelId: null,
  provider: null,
  status: "connecting",
  kernelReady: false,
  historyRefreshTrigger: 0,
  busStream: [],
  communicatorStatus: "idle",
  pendingQuestions: [],
  answerDraft: new Map<string, string>(),
  turns: [],
  currentTurn: null,
  currentUsage: { input: 0, output: 0, costUsd: 0 },
  totalUsage: { input: 0, output: 0, costUsd: 0 },
  error: null,
  socket: null,

  attachSocket(socket: { send(cmd: unknown): void } | null) {
    set({ socket });
  },

  sendLoadConversation(conversationId: string) {
    const socket = get().socket as { send(cmd: unknown): void } | null;
    socket?.send({ type: "load_conversation", conversationId });
  },
  sendAnswerQuestion(questionId: string, payload: string) {
    const socket = get().socket as { send(cmd: unknown): void } | null;
    const conversationId = get().conversationId ?? "";
    // B10-3(F4):乐观移除 —— server 对 answer_question 成功路径不回发任何事件,
    // 不移除则已回答的提问卡永久残留(Timeline 幽灵卡片)。回答错了大不了
    // no_pending_question error 兜底(也会移除)。顺带清掉该项草稿。
    set((s) => {
      const draft = new Map(s.answerDraft);
      draft.delete(questionId);
      return {
        pendingQuestions: s.pendingQuestions.filter((q) => q.questionId !== questionId),
        answerDraft: draft,
      };
    });
    socket?.send({ type: "answer_question", questionId, payload, conversationId });
  },
  sendCancelQuestion(questionId: string) {
    const socket = get().socket as { send(cmd: unknown): void } | null;
    const conversationId = get().conversationId ?? "";
    // B10-3(F4):同上,乐观移除(cancel_question 成功路径 server 也不回发事件)。
    set((s) => {
      const draft = new Map(s.answerDraft);
      draft.delete(questionId);
      return {
        pendingQuestions: s.pendingQuestions.filter((q) => q.questionId !== questionId),
        answerDraft: draft,
      };
    });
    socket?.send({ type: "cancel_question", questionId, conversationId });
  },
  setAnswerDraft(questionId: string, text: string) {
    set((s) => {
      const next = new Map(s.answerDraft);
      if (text) next.set(questionId, text);
      else next.delete(questionId);
      return { answerDraft: next };
    });
  },

  reset() {
    set((s) => ({
      turns: [],
      currentTurn: null,
      currentUsage: { input: 0, output: 0, costUsd: 0 },
      error: null,
      status: "idle",
      kernelReady: s.kernelReady,
      // M3c: 重置不刷 bus stream(多会话复用,跨 turn 可见)
      // 只有 talk 主动清空才动它
    }));
  },

  appendUserTurn(text: string) {
    const t = newTurn(`u_${Date.now().toString(36)}`, "user");
    set((s) => ({ turns: [...s.turns, { ...t, blocks: [{ kind: "text", text }] }] }));
  },

  async newConversation() {
    try {
      const r = await fetch("/api/conversation/new", { method: "POST" });
      const data = (await r.json()) as { conversationId?: string };
      set((s) => ({
        conversationId: data.conversationId ?? null,
        turns: [],
        currentTurn: null,
        currentUsage: { input: 0, output: 0, costUsd: 0 },
        error: null,
        status: "idle",
        // kernelReady 保持:后端 invalidate 了 session,下次 send 会重建;
        // 但 provider/model 不变,所以不清 kernelReady,避免 UI 闪 "未连接"
        kernelReady: s.kernelReady,
        // B10-1(F2):新会话 → 清空旧会话 bus 流与遗留提问
        busStream: [],
        pendingQuestions: [],
      }));
    } catch {
      // 忽略,UI 保持原状
    }
  },

  loadConversation(snapshot: ConversationSnapshot) {
    const { conversation, messages } = snapshot;
    // 每个 message → 一个 turn;blocks 从 content + toolCalls 还原
    const turns: Turn[] = messages.map((m) => {
      const blocks: Block[] = [];
      if (m.thinking) blocks.push({ kind: "thinking", text: m.thinking });
      if (m.content) blocks.push({ kind: "text", text: m.content });
      if (m.toolCalls) {
        try {
          const parsed = JSON.parse(m.toolCalls) as Array<{
            id: string;
            name: string;
            args?: unknown;
            result?: unknown;
            isError?: boolean;
            durationMs?: number;
          }>;
          for (const tc of parsed) {
            blocks.push({ kind: "tool", tool: tc });
          }
        } catch {
          // 解析失败,丢弃 toolCalls
        }
      }
      // user / assistant / tool / system
      const role = m.role === "tool" ? "assistant" : m.role === "system" ? "system" : (m.role as Role);
      return {
        id: m.id,
        role,
        blocks,
        startedAt: m.createdAt,
        endedAt: m.createdAt,
        usage: { input: m.usageInput, output: m.usageOutput },
        isStreaming: false,
      };
    });

    set((s) => ({
      conversationId: conversation.id,
      turns,
      currentTurn: null,
      currentUsage: { input: 0, output: 0, costUsd: 0 },
      totalUsage: {
        input: conversation.totalInputTokens,
        output: conversation.totalOutputTokens,
        costUsd: conversation.totalCostUsd,
      },
      error: null,
      status: "idle",
      // 加载历史:kernel 没有为这个 conversationId 开工,标 false 让 UI 提示
      kernelReady: false,
      modelId: conversation.modelId ?? s.modelId,
      provider: conversation.provider ?? s.provider,
      // B10-1(F2):切会话清空 bus 流与遗留提问 —— Timeline 只显示当前会话,
      // 残留会让「全局流」混入上一会话的消息;ready/bus_replay 会重新拉本会话的。
      busStream: [],
      pendingQuestions: [],
    }));
  },

  applyEvent(e: ServerEvent) {
    const state = get();
    switch (e.type) {
      case "ready": {
        // B10-2(F3):server (重)启会重置 kernel conversationId,无条件覆盖会让
        // 本地 UI 与 server 会话错位(后续 send 全落到 server 的新会话上)。
        // - 本地有内容(turns/currentTurn)且 id 不同 → 保留本地 id,发
        //   load_conversation 让 server resume 过来(ws.ts handler 先 ensureStarted
        //   再按需 resume,session 未启动也安全);server resume 成功后会再发一个
        //   id 一致的 ready,自然收敛,不会回环。
        // - 本地无内容 → 直接采用 server id,并清掉旧会话的 busStream。
        const local = state.conversationId;
        const hasLocalContent = state.turns.length > 0 || state.currentTurn !== null;
        let conversationId = e.conversationId;
        let busStream = state.busStream;
        const socket = state.socket as { send(cmd: unknown): void } | null;
        if (local && local !== e.conversationId && hasLocalContent) {
          conversationId = local;
          socket?.send({ type: "load_conversation", conversationId: local });
        } else if (local !== e.conversationId) {
          busStream = [];
        }
        set({
          conversationId,
          modelId: e.modelId,
          provider: e.provider,
          error: null,
          status: "idle",
          kernelReady: true,
          // B10-2:ready = kernel 会话(重)建,旧的 pending question 已随旧 session
          // 失效 —— 清空,防止幽灵提问卡常驻(回答必然 no_pending_question)。
          pendingQuestions: [],
          busStream,
        });
        // B10-1(F2):ready 后拉 bus 历史重放 —— 刷新/重连后 Timeline 能看到之前的
        // 消息。fromTs 取本地该会话已有消息的最大 ts(server 端过滤 ts >= fromTs,
        // 边界重叠由 bus_event 的 id 去重兜住);本地没有则从 0 全量拉。
        if (socket) {
          const fromTs = busStream.reduce(
            (mx, m) => (m.conversationId === conversationId && m.ts > mx ? m.ts : mx),
            0,
          );
          socket.send({ type: "bus_replay", conversationId, fromTs });
        }
        return;
      }
      case "agent_start":
        set({ status: "streaming", error: null });
        return;
      case "turn_start": {
        const turn = newTurn(`as_${e.turnIndex}_${Date.now().toString(36)}`, "assistant");
        set({ currentTurn: turn, status: "streaming", error: null });
        return;
      }
      case "message_start": {
        return;
      }
      case "delta": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "text") {
          blocks[blocks.length - 1] = { kind: "text", text: last.text + e.text };
        } else {
          blocks.push({ kind: "text", text: e.text });
        }
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "thinking_delta": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "thinking") {
          blocks[blocks.length - 1] = { kind: "thinking", text: last.text + e.text };
        } else {
          blocks.push({ kind: "thinking", text: e.text });
        }
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "tool_start": {
        const cur = get().currentTurn;
        if (!cur) return;
        set({
          currentTurn: {
            ...cur,
            blocks: [...cur.blocks, { kind: "tool", tool: { id: e.tool.id, name: e.tool.name, args: e.tool.args } }],
          },
        });
        return;
      }
      case "tool_end": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = cur.blocks.map((b) =>
          b.kind === "tool" && b.tool.id === e.tool.id
            ? {
                kind: "tool" as const,
                tool: {
                  ...b.tool,
                  result: e.tool.result,
                  isError: e.tool.isError,
                  durationMs: e.tool.durationMs,
                },
              }
            : b,
        );
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "message_end": {
        const cur = get().currentTurn;
        if (!cur) return;
        set({
          currentTurn: { ...cur, usage: e.usage, isStreaming: false },
        });
        return;
      }
      case "agent_end": {
        const cur = get().currentTurn;
        const turns = cur ? [...state.turns, { ...cur, endedAt: Date.now(), isStreaming: false }] : state.turns;
        const totalInput = state.totalUsage.input + (e.usage?.input ?? 0);
        const totalOutput = state.totalUsage.output + (e.usage?.output ?? 0);
        const totalCost = state.totalUsage.costUsd + (e.usage?.costUsd ?? 0);
        set({
          turns,
          currentTurn: null,
          currentUsage: { input: 0, output: 0, costUsd: 0 },
          totalUsage: { input: totalInput, output: totalOutput, costUsd: totalCost },
          status: "idle",
        });
        return;
      }
      case "error": {
        // B10-3(F4):no_pending_question 说明该 question 在 server 端已不存在
        // (已答/已取消/超时)→ 本地幽灵卡片同步移除。questionId 从错误消息解析
        // (server 端格式:`question ${id} 不在 pending`),无需新增 server 事件。
        const staleQid =
          e.error.code === "no_pending_question"
            ? (/question\s+(\S+)/.exec(e.error.message)?.[1] ?? null)
            : null;
        set((s) => ({
          status: "error",
          error: e.error,
          ...(staleQid
            ? { pendingQuestions: s.pendingQuestions.filter((q) => q.questionId !== staleQid) }
            : {}),
        }));
        return;
      }
      case "interrupt":
        set({ status: "idle" });
        return;
      case "conversation_reset":
        set({
          conversationId: e.conversationId,
          turns: [],
          currentTurn: null,
          currentUsage: { input: 0, output: 0, costUsd: 0 },
          error: null,
          status: "idle",
          // B10-1(F2)/B10-2:server 端开了新会话 → 旧会话 bus 流与遗留提问全部作废
          busStream: [],
          pendingQuestions: [],
        });
        return;
      case "title_changed":
        // 递增 historyRefreshTrigger,HistoryRail useEffect 依赖它,
        // 触发侧边列表重新拉取。
        set((s) => ({
          historyRefreshTrigger: s.historyRefreshTrigger + 1,
        }));
        return;
      case "bus_event":
        // 任何 BusMessage 都进 busStream;cap 2000,内存只留最近。
        // B10-1(F2):按 message.id 去重 —— 重连后的 bus_replay(fromTs 含边界)
        // 与实时推送可能重叠,不去重 Timeline 会出现成对重复消息。
        set((s) => {
          if (s.busStream.some((m) => m.id === e.message.id)) return s;
          const next = [...s.busStream, e.message];
          if (next.length > 2000) next.splice(0, next.length - 2000);
          return { busStream: next };
        });
        return;
      case "communicator_thinking":
        set({ communicatorStatus: e.status });
        return;
      case "pending_question":
        set((s) => ({
          pendingQuestions: [
            ...s.pendingQuestions,
            {
              questionId: e.questionId,
              payload: e.payload,
              fromRole: e.fromRole,
              ts: Date.now(),
            },
          ],
        }));
        return;
      case "plan_done": {
        // B10-5:server 一直在发 plan_done(ws.ts runPlan),但旧版 shared/types/ws.ts
        // 的 ServerEvent union 缺这个成员 → 前端静默丢弃,/plan 完成用户零反馈。
        // 最小接线:summary 作为一条可见 assistant 消息追加到当前会话(总结卡渲染
        // 属批次 3 的 UI 范围,这里先保证「完成有反馈」)。
        const t = newTurn(`plan_done_${Date.now().toString(36)}`, "assistant");
        set((s) => ({
          turns: [
            ...s.turns,
            { ...t, blocks: [{ kind: "text", text: e.summary }], endedAt: Date.now() },
          ],
          status: "idle",
          error: null,
        }));
        return;
      }
      case "plan_failed": {
        // B10-5:plan 失败 → 追加可见错误消息 + 置 error 状态(ChatSurface 横幅)。
        const t = newTurn(`plan_failed_${Date.now().toString(36)}`, "assistant");
        set((s) => ({
          turns: [
            ...s.turns,
            {
              ...t,
              blocks: [{ kind: "text", text: `计划失败:${e.message}` }],
              endedAt: Date.now(),
            },
          ],
          status: "error",
          error: { code: "plan_failed", message: e.message },
        }));
        return;
      }
    }
  },
}));