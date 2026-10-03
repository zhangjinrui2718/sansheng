/**
 * Sansheng Chat Store · Zustand
 *
 * 单一对话流(M1);M3+ 拆多会话。
 */
import { create } from "zustand";
import type { ServerEvent } from "@shared/types/ws";
import type { Block, PlanBlockData } from "@shared/types/chat";

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
  /**
   * 批次 UI U1:递增计数,工件/目标页 useEffect 依赖它来重新拉取。
   *
   * 为什么用计数而不是把 artifact 直接塞进 store:工件页的权威数据源是
   * `GET /api/artifacts?conversationId=`(SQLite 里带完整 body/metadata/依赖),
   * WS 事件只是「有变更」的信号;真值永远回查后端,避免前后端两份不一致。
   * 触发源:artifact_created / artifact_status_changed / harness_proposal_created
   * / plan_done(带 artifacts[])/ conversation_reset(换会话后 id 变了)。
   */
  artifactRevision: number;
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
  /** 批次 UI U2(C10-1):Esc 中断 —— 发 { type: "interrupt" } 给 server 的 kernel.abort() */
  sendInterrupt(): void;
  /**
   * 批次 8-C:中止当前 plan —— 发 { type: "abort_plan" }。**不可撤销**
   * (server 会 abort 掉在飞的 executor),故先把计划卡按钮锁死再发命令。
   * 计划卡「中止」按钮的唯一出口。
   */
  sendAbortPlan(): void;
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

/**
 * 批次 8-C:就地改「最后一张计划卡」。没找到就原样返回同一个数组引用
 * (诚实渲染:不凭空造卡 —— 计划卡只在真的收到 plan_planned 时存在)。
 *
 * 为什么只替换一个 turn:MessageList 的 TurnView 走 React.memo,未变的 turn
 * 保持同一对象引用即不会重渲染。plan_todo_update 每次只碰一行,整卡重渲染会闪。
 */
function withLastPlan(turns: Turn[], fn: (plan: PlanBlockData) => PlanBlockData): Turn[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    const blocks = turn.blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (!b || b.kind !== "plan") continue;
      const plan = fn(b.plan);
      if (plan === b.plan) return turns;
      const nextBlocks = blocks.slice();
      nextBlocks[j] = { kind: "plan", plan };
      const next = turns.slice();
      next[i] = { ...turn, blocks: nextBlocks };
      return next;
    }
  }
  return turns;
}

/**
 * 批次 8-C:计划卡终态那一行。**所有数字都来自这张卡自己的 todos**
 * (resolved/superseded 计入完成、failed 计入失败),不引用 plan_done.summary ——
 * summary 回答「做出了什么」,这里回答「这份拆解走到哪了」。
 */
function planDoneLine(plan: PlanBlockData): string {
  const done = plan.todos.filter((t) => t.status === "resolved" || t.status === "superseded").length;
  const failed = plan.todos.filter((t) => t.status === "failed").length;
  const parts = [`${done}/${plan.todos.length} 步完成`];
  if (failed > 0) parts.push(`${failed} 步失败`);
  if (plan.abortRequested) parts.push("已请求中止");
  return parts.join(" · ");
}

/** 批次 8-C:点过中止才叫「已中止」,否则叫「已失败」—— 两种收场不混着说。 */
function planFailedLine(plan: PlanBlockData, message: string): string {
  return `${plan.abortRequested ? "已中止" : "已失败"} · ${message}`;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversationId: null,
  modelId: null,
  provider: null,
  status: "connecting",
  kernelReady: false,
  historyRefreshTrigger: 0,
  artifactRevision: 0,
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
  sendInterrupt() {
    // 批次 UI U2(C10-1「Esc 中断」空头承诺):server 侧能力**一直存在**
    // (ws.ts:542 → kernel.abort() → 回发 interrupt 事件),只是前端从没有调用方。
    // 这里补上唯一的命令出口,ChatComposer 的 Escape 键经它下发。
    const socket = get().socket as { send(cmd: unknown): void } | null;
    socket?.send({ type: "interrupt" });
  },
  sendAbortPlan() {
    // 批次 8-C:中止是**不可撤销**动作 —— server 侧 abort_plan 分支会
    // orchestrator.abort()(退订 bus + abort 在飞 executor),没有撤销路径。
    // 顺序:先锁按钮(abortRequested)再发命令,同帧生效,防住连点。
    // 无 socket 时**不改** abortRequested:按钮还亮着,用户可以在重连后再点。
    // 假称「已发送中止」而命令根本没出去,比多点一次糟糕得多。
    const socket = get().socket as { send(cmd: unknown): void } | null;
    if (!socket) return;
    set((s) => ({
      turns: withLastPlan(
        s.turns,
        (p) => (p.abortRequested || p.terminal ? p : { ...p, abortRequested: true }),
      ),
    }));
    socket.send({ type: "abort_plan" });
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
        // 批次 UI U2(C10-2「TopBar currentUsage 恒 0」):旧实现只把 usage 挂到
        // turn 上,**从不**累加进 currentUsage —— TopBar 的「本轮 idle」因此永远
        // 显示,是一句没有任何数据支撑的常量文案。这里把每条 message_end 的真实
        // usage 累加进 currentUsage,agent_end 再清零(costUsd 只在 agent_end 有,
        // 故中途恒 0 —— TopBar 侧对 costUsd=0 不渲染金额,避免显示假的 $0.0000)。
        const prev = get().currentUsage;
        set({
          currentTurn: {
            ...cur,
            usage: e.usage,
            isStreaming: false,
          },
          currentUsage: {
            input: prev.input + (e.usage?.input ?? 0),
            output: prev.output + (e.usage?.output ?? 0),
            costUsd: prev.costUsd,
          },
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
      case "artifact_created":
      case "artifact_status_changed":
      case "harness_proposal_created": {
        // 批次 UI U1:这三种事件只作「有变更」信号,工件/目标页经 artifactRevision
        // 回查 GET /api/artifacts 拿权威数据(此前这三个成员在 switch 里没有 case,
        // 到达即被静默丢弃 —— 审查 §A5 记录的「artifact 生命周期 UI 不可见」)。
        set((s) => ({ artifactRevision: s.artifactRevision + 1 }));
        return;
      }
      case "executor_callback":
      case "executor_resume":
        // executor 阻塞/恢复本身不改工件字段(状态由 executor 的 artifact_status_changed
        // 落库),但用户视图需要即时刷新(目标页的「等决策」计数),故同样打戳。
        set((s) => ({ artifactRevision: s.artifactRevision + 1 }));
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
      case "plan_planned": {
        // 批次 8-C:计划一拆出来就上屏。**此前 orchestrator 一直在发 todos_planned,
        // ws.ts 的 progress 回调却是 default: break 直接丢掉**(见 src/server/ws.ts
        // runPlan)—— 用户交办一件事,直到跑完才第一次看见结果,中间全靠猜。
        // 自成一张 assistant turn(与 plan_done 总结卡同一区域、同一形态):
        // /plan 路径本来就没有 turn_start,挂 currentTurn 会被流式文本打散。
        const t = newTurn(`plan_${Date.now().toString(36)}`, "assistant");
        const plan: PlanBlockData = {
          intentId: e.intentId,
          // reason 初始恒 null:失败原因只来自 plan_todo_update(todo_failed),
          // plan_planned 这一刻还没有任何一步失败过 —— 不预填。
          todos: e.todos.map((td) => ({ ...td, reason: null })),
          abortRequested: false,
          terminal: null,
        };
        set((s) => ({ turns: [...s.turns, { ...t, blocks: [{ kind: "plan", plan }] }] }));
        return;
      }
      case "plan_todo_update": {
        // 批次 8-C:**只改那一行**。map 出的新数组里,没变的 todo 保持同一对象引用,
        // memo 化的 TodoRow 因此不重渲染(整卡重渲染会让正在滚动的聊天闪)。
        const turns = withLastPlan(get().turns, (p) => {
          const idx = p.todos.findIndex((td) => td.id === e.todoId);
          // 契约外的 todoId:原样返回,不多造一行(未知状态不编)。
          if (idx < 0) return p;
          const prev = p.todos[idx];
          if (!prev) return p;
          const todos = p.todos.slice();
          todos[idx] = { ...prev, status: e.status, reason: e.reason };
          return { ...p, todos };
        });
        if (turns !== get().turns) set({ turns });
        return;
      }
      case "plan_done": {
        // B10-5:server 一直在发 plan_done(ws.ts runPlan),但旧版 shared/types/ws.ts
        // 的 ServerEvent union 缺这个成员 → 前端静默丢弃,/plan 完成用户零反馈。
        // 最小接线:summary 作为一条可见 assistant 消息追加到当前会话(总结卡渲染
        // 属批次 3 的 UI 范围,这里先保证「完成有反馈」)。
        const t = newTurn(`plan_done_${Date.now().toString(36)}`, "assistant");
        // 批次 7-I(B):summary 是「做完了吗」,deliveries 是「做出来的是什么」。
        // 7-I 之前只渲染 summary —— 协议上早就带着 artifacts,前端却丢了,
        // 于是产物只躺在 blackboard 里,要用户自己去「工件」tab 翻。
        const deliveryBlocks: Block[] =
          e.deliveries && e.deliveries.length > 0
            ? [{ kind: "delivery", items: e.deliveries }]
            : [];
        set((s) => ({
          turns: [
            // 批次 8-C:顺手把上面那张计划卡收进终态(隐藏「中止」按钮 + 写终态行)。
            // 终态只写一次:迟到的 plan_done 不会覆盖已经写下的 plan_failed。
            ...withLastPlan(s.turns, (p) =>
              p.terminal ? p : { ...p, terminal: { kind: "done", text: planDoneLine(p) } },
            ),
            { ...t, blocks: [{ kind: "text", text: e.summary }, ...deliveryBlocks], endedAt: Date.now() },
          ],
          status: "idle",
          error: null,
          // 一轮 plan 收尾(工件状态批量改写)→ 工件/目标页该重新拉一次
          artifactRevision: s.artifactRevision + 1,
        }));
        return;
      }
      case "plan_failed": {
        // B10-5:plan 失败 → 追加可见错误消息 + 置 error 状态(ChatSurface 横幅)。
        const t = newTurn(`plan_failed_${Date.now().toString(36)}`, "assistant");
        set((s) => ({
          turns: [
            // 批次 8-C:这张事件也是**用户点了「中止」之后**唯一会回来的收场
            // (server: abort → run() reject → 走这里),所以计划卡在这里同样进终态。
            ...withLastPlan(s.turns, (p) =>
              p.terminal ? p : { ...p, terminal: { kind: "failed", text: planFailedLine(p, e.message) } },
            ),
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