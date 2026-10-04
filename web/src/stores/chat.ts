/**
 * Sansheng Chat Store · Zustand(项目为中心)
 *
 * ── 旧 → 新 的模型变化(整份重写)────────────────────────────────
 *
 * 旧 store 以 `conversationId` 组织一切:`send` 命令带 conversationId、
 * `load_conversation` / `bus_replay` 拉总线历史、`plan_*` 事件累积计划卡、
 * `pending_question` 是瞬态消息。这些机制在新架构里**都不存在了**:
 *
 *   - 「项目」是一等实体,每个项目**一条连续对话** → 本项目 = `projectId`;
 *   - 计划已删,换成 works(工作项)→ 计划卡相关代码整段删除;
 *   - `pending_question`(瞬态消息)→ `client_question`(**工件,持久**)→
 *     前端不再在 store 里攒提问,而是收到事件后**回查后端**(见 `bumpRevisions`);
 *   - 总线已删 → `busStream` 整个字段删除。
 *
 * ── 一条纪律:事件只是「有变更」的信号,真值回查后端 ────────────────
 *
 * WS 推来的 `work_changed` / `artifact_created` / `client_question` 只带增量
 * (一句 status / 一个 id),不带完整视图。store 因此**不自己拼数据**,只递增
 * `projectRevision` / `projectsRevision`,让页面按需回查 `GET /api/...` 拿权威数据。
 * 这样前后端不会有两份会漂移的真相。
 */
import { create } from "zustand";
import {
  eventProjectId,
  type ProjectSummary,
  type ServerEvent,
  type SessionMessageView,
  type WsToolInfo,
} from "@shared/types/platform";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { PlatformSocket } from "../lib/ws";

export type Role = "user" | "assistant" | "system";

/**
 * 一个 turn 内的逻辑块。与旧 `shared/types/chat.ts` 的 `Block` 相比:
 * `plan` / `delivery` 两个成员已删除(计划概念已删),其余形状不变 ——
 * MessageList / ToolCallCard / ThinkingBlock 因此只需改 import,不用重写渲染。
 */
export type Block =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: WsToolInfo };

export interface Turn {
  id: string;
  role: Role;
  blocks: Block[];
  startedAt: number;
  endedAt?: number;
  usage?: { input: number; output: number };
  isStreaming?: boolean;
}

export type ChatStatus = "idle" | "streaming" | "error" | "connecting";

export interface ChatState {
  // ── 项目 ──
  projects: ProjectSummary[];
  projectsLoading: boolean;
  /** 当前项目 = 当前上下文(项目即上下文容器)。 */
  projectId: string | null;
  /**
   * 是否正在**接待会话**(第一个项目之前那段,见 `@shared/types/platform`)。
   *
   * 为什么不把「接待中」直接编码成 `projectId === null`:null 在此之前就已经有
   * 一个含义 —— **还没选项目**(有项目但用户没点)。两者混成一个值,界面就再也
   * 分不清「该显示接待对话」还是「该显示『先选一个项目』」。
   * 合法组合只有三种:`(true, null)` 接待中、`(false, null)` 未选、`(false, id)` 项目内。
   */
  intakeActive: boolean;
  /** 首屏上下文是否已经决定过(见 `decideInitialContext`)。 */
  contextDecided: boolean;
  /** 当前项目的工作项 / 工件 / 提问发生变更 —— 详情页据此回查。 */
  projectRevision: number;
  /** 项目列表本身的变更(新建 / 状态变化 / 待答问题数变化)。 */
  projectsRevision: number;

  // ── 对话 ──
  turns: Turn[];
  currentTurn: Turn | null;

  // ── 运行态 ──
  modelId: string | null;
  provider: string | null;
  status: ChatStatus;
  error: { code: string; message: string } | null;
  currentUsage: { input: number; output: number };
  totalUsage: { input: number; output: number };
  socket: PlatformSocket | null;

  loadProjects(): Promise<void>;
  selectProject(id: string): Promise<void>;
  /**
   * **首屏上下文**:拉项目列表,一个项目都没有就进接待会话;有项目就什么都不做
   * (保持原来的「未选项目」,不擅自替用户选中某个项目)。
   *
   * 做成 store 动作而不是 App 里的 effect,有两个具体理由:
   *   1. 它必须**等列表拉回来**再决定。写成 `useEffect` 靠 `projectsLoading`
   *      判断会读到那次渲染的旧值(false)—— 有项目的用户会先被丢进接待会话,
   *      而且再也没人把他切回来。
   *   2. 这样它可以在 node 里被直接测(见 tests/web/app-socket.test.ts)——
   *      「有项目时**不**进接待会话」是这件事最容易写错、也最难在界面上发现的一半。
   *
   * 幂等:`contextDecided` 置起后再调直接返回(StrictMode 双 effect 安全)。
   */
  decideInitialContext(): Promise<void>;
  /**
   * 切到**接待会话**:与业务经理谈一个新项目。
   *
   * 这是「新建项目」按钮现在做的事 —— 它不再打开一张 name / client / goal 表单。
   * 立项由业务经理在谈拢之后执行(`project_open`),前端只负责显示这段对话;
   * 服务端随后广播 `project_opened`,本 store 自动切到新项目。
   */
  startIntake(): Promise<void>;
  /** 拉接待会话的历史(首屏没有项目时、以及刷新之后)。 */
  loadIntakeMessages(): Promise<void>;
  sendMessage(text: string): void;
  sendInterrupt(): void;
  /** 回答问题(HTTP POST;WS 也有等价命令,前端统一走 HTTP 有回执)。 */
  answerQuestion(questionId: string, answer: string): Promise<boolean>;
  attachSocket(s: PlatformSocket | null): void;
  reset(): void;
  applyEvent(e: ServerEvent): void;
}

const newTurn = (id: string, role: Role): Turn => ({
  id,
  role,
  blocks: [],
  startedAt: Date.now(),
  isStreaming: false,
});

/**
 * 会话消息(后端扁平形状)→ turn。
 *
 * `kind: "tool"` 的行**没有**结构化字段(一条消息只有 content),所以这里不编造
 * 工具名 —— `name` 直接用契约里的原始 kind 值,`result` 放 content。宁可显示
 * 一个英文 kind,也不假装知道当时调的是什么工具。
 */
function messageToTurn(m: SessionMessageView): Turn {
  const blocks: Block[] = [];
  switch (m.kind) {
    case "thinking":
      blocks.push({ kind: "thinking", text: m.content });
      break;
    case "tool":
      blocks.push({ kind: "tool", tool: { id: m.id, name: "tool", result: m.content } });
      break;
    default:
      if (m.content.length > 0) blocks.push({ kind: "text", text: m.content });
  }
  const role: Role =
    m.kind === "user" ? "user" : m.kind === "system" ? "system" : "assistant";
  return {
    id: m.id,
    role,
    blocks,
    startedAt: m.createdAt,
    endedAt: m.createdAt,
    isStreaming: false,
  };
}

export const useChatStore = create<ChatState>((set, get) => ({
  projects: [],
  projectsLoading: false,
  projectId: null,
  intakeActive: false,
  contextDecided: false,
  projectRevision: 0,
  projectsRevision: 0,

  turns: [],
  currentTurn: null,

  modelId: null,
  provider: null,
  status: "connecting",
  error: null,
  currentUsage: { input: 0, output: 0 },
  totalUsage: { input: 0, output: 0 },
  socket: null,

  attachSocket(socket) {
    set({ socket });
  },

  async loadProjects() {
    set({ projectsLoading: true });
    try {
      const { projects } = await api.listProjects();
      set({ projects: Array.isArray(projects) ? projects : [], projectsLoading: false, error: null });
    } catch (e) {
      set({ projectsLoading: false, error: { code: "projects_load_failed", message: errorMessage(e) } });
    }
  },

  async selectProject(id) {
    set({
      projectId: id,
      intakeActive: false,
      turns: [],
      currentTurn: null,
      error: null,
      status: "idle",
    });
    try {
      const res = await api.getProjectMessages(id);
      // 拉取期间用户可能已经切走 —— 迟到的响应不许覆盖当前项目。
      if (get().projectId !== id) return;
      set({
        turns: (res.messages ?? []).map(messageToTurn),
        currentTurn: null,
        status: "idle",
      });
    } catch (e) {
      if (get().projectId !== id) return;
      set({ error: { code: "messages_load_failed", message: errorMessage(e) }, status: "error" });
    }
  },

  async decideInitialContext() {
    if (get().contextDecided) return;
    set({ contextDecided: true });
    // **先等列表回来再决定** —— 这正是不能写成 `useEffect` 靠 projectsLoading
    // 判断的原因(那时读到的是本次渲染的旧值 false,有项目的用户会被丢进接待会话)
    await get().loadProjects();
    if (get().projects.length === 0) await get().startIntake();
  },

  async startIntake() {
    set({
      projectId: null,
      intakeActive: true,
      turns: [],
      currentTurn: null,
      error: null,
      status: "idle",
    });
    await get().loadIntakeMessages();
  },

  async loadIntakeMessages() {
    try {
      const res = await api.getIntakeMessages();
      // 拉取期间用户可能已经切到某个项目 —— 迟到的响应不许覆盖当前上下文。
      if (!get().intakeActive) return;
      set({
        turns: (res.messages ?? []).map(messageToTurn),
        currentTurn: null,
        status: "idle",
      });
    } catch (e) {
      if (!get().intakeActive) return;
      set({ error: { code: "messages_load_failed", message: errorMessage(e) }, status: "error" });
    }
  },

  sendMessage(text) {
    const { projectId, intakeActive, socket } = get();
    if (!socket) return;
    // 既没选项目、也不在接待会话 —— 没有可发送的上下文(而不是发进 void)
    if (projectId === null && !intakeActive) return;
    const t = newTurn(`u_${Date.now().toString(36)}`, "user");
    set((s) => ({ turns: [...s.turns, { ...t, blocks: [{ kind: "text", text }] }] }));
    // 接待会话发送 `projectId: null` —— 契约里这就是「第一个项目之前」那条会话
    socket.sendToProject(intakeActive ? null : projectId, text);
  },

  sendInterrupt() {
    const { projectId, intakeActive, socket } = get();
    if (!socket) return;
    if (projectId === null && !intakeActive) return;
    socket.interrupt(intakeActive ? null : projectId);
  },

  async answerQuestion(questionId, answer) {
    try {
      await api.answerClientQuestion(questionId, answer);
      // 答完 → 问题从队列消失、落一条 decision 工件:两个列表都该重拉。
      set((s) => ({
        projectRevision: s.projectRevision + 1,
        projectsRevision: s.projectsRevision + 1,
      }));
      return true;
    } catch (e) {
      set({ error: { code: "answer_failed", message: errorMessage(e) } });
      return false;
    }
  },

  reset() {
    set({
      turns: [],
      currentTurn: null,
      currentUsage: { input: 0, output: 0 },
      error: null,
      status: "idle",
    });
  },

  applyEvent(e) {
    switch (e.type) {
      case "ready": {
        set({
          modelId: e.modelId,
          provider: e.provider,
          status: "idle",
          error: null,
        });
        return;
      }
      case "pong":
        return;

      case "message_start": {
        // 用户那条消息在 sendMessage 里已乐观上屏,server 的 message_start
        // 再上一条就是重复。助手消息才是流式的载体。
        if (e.role === "user") return;
        set({
          currentTurn: { ...newTurn(e.messageId, "assistant"), isStreaming: true },
          status: "streaming",
          error: null,
        });
        return;
      }
      case "delta": {
        const cur = get().currentTurn ?? newTurn(e.messageId, "assistant");
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: last.text + e.text };
        else blocks.push({ kind: "text", text: e.text });
        set({ currentTurn: { ...cur, blocks, isStreaming: true }, status: "streaming" });
        return;
      }
      case "thinking_delta": {
        // 推理与正文是两条流,永不混流(契约注释里的 7-I 现场)。这里靠 block
        // 的 kind 分开累积 —— 与正文各自的「最后一个同类块」拼接。
        const cur = get().currentTurn ?? newTurn(e.messageId, "assistant");
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "thinking") {
          blocks[blocks.length - 1] = { kind: "thinking", text: last.text + e.text };
        } else {
          blocks.push({ kind: "thinking", text: e.text });
        }
        set({ currentTurn: { ...cur, blocks, isStreaming: true }, status: "streaming" });
        return;
      }
      case "tool_start": {
        const cur = get().currentTurn ?? newTurn(e.messageId, "assistant");
        set({
          currentTurn: { ...cur, blocks: [...cur.blocks, { kind: "tool", tool: e.tool }] },
        });
        return;
      }
      case "tool_end": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = cur.blocks.map((b) =>
          b.kind === "tool" && b.tool.id === e.tool.id ? { kind: "tool" as const, tool: e.tool } : b,
        );
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "message_end": {
        const cur = get().currentTurn;
        if (!cur) return;
        const usage = e.usage;
        set((s) => ({
          currentTurn: { ...cur, isStreaming: false, usage },
          currentUsage: {
            input: s.currentUsage.input + (usage?.input ?? 0),
            output: s.currentUsage.output + (usage?.output ?? 0),
          },
        }));
        return;
      }
      case "agent_end": {
        const cur = get().currentTurn;
        set((s) => ({
          turns: cur ? [...s.turns, { ...cur, endedAt: Date.now(), isStreaming: false }] : s.turns,
          currentTurn: null,
          status: "idle",
          // 一轮结束 = 工作项 / 工件大概率被改过 —— 让页面回查。
          projectRevision: s.projectRevision + 1,
          projectsRevision: s.projectsRevision + 1,
        }));
        return;
      }

      case "project_opened": {
        // 业务经理在**接待会话**里把项目立起来了(契约 `ServerEvent.project_opened`)。
        // 列表要重拉(左栏多一条);如果用户此刻就坐在接待会话里,直接切到新项目 ——
        // 那条对话的消息已经被服务端迁进新项目了,留在原地会看到一段空对话。
        //
        // **只在接待中才切**:同一事件也可能来自「用户在项目 A 里让业务经理又立了一个
        // 项目 B」,那时把用户从 A 拽走比让他自己点过去更糟。
        const onIntake = get().intakeActive;
        set((s) => ({ projectsRevision: s.projectsRevision + 1 }));
        if (onIntake) void get().selectProject(e.projectId);
        return;
      }

      case "client_question":
      case "client_question_answered":
      case "artifact_created":
      case "work_changed":
      case "blocker_changed": {
        // 事件只是「有变更」的信号,真值回查后端(见文件头)。两个戳分开是有意的:
        // 别的项目来了一个问题 → 左栏徽标该动,但当前项目的详情不该重拉。
        const pid = eventProjectId(e);
        const active = get().projectId;
        set((s) => ({
          projectsRevision: s.projectsRevision + 1,
          projectRevision: s.projectRevision + (pid === null || pid === active ? 1 : 0),
        }));
        return;
      }

      case "error": {
        // 带 projectId 的错误只对那个项目有意义:别的项目的面板不该被刷成错误态。
        if (e.projectId !== undefined && e.projectId !== get().projectId) return;
        set({ status: "error", error: e.error });
        return;
      }

      case "cascade_stopped": {
        // 驱动者循环在异常位置停下了。**不能当成普通 idle** —— 界面回到 idle
        // 而用户以为「还在跑」或「已经做完了」,这两种误解都会让他在错误的时刻
        // 做决定。服务端同时落了一条 system 会话消息(刷新后还在),
        // 这里只负责把两个 revision 推一推,让那条消息和列表尽快出现在屏幕上。
        const pid = eventProjectId(e);
        const active = get().projectId;
        set((s) => ({
          projectsRevision: s.projectsRevision + 1,
          projectRevision: s.projectRevision + (pid === null || pid === active ? 1 : 0),
        }));
        return;
      }
    }
  },
}));

/** 供组件按 id 找项目(左栏/详情页共用,避免各自 find)。 */
export function projectById(
  projects: ProjectSummary[],
  id: string | null,
): ProjectSummary | undefined {
  if (id === null) return undefined;
  return projects.find((p) => p.id === id);
}
