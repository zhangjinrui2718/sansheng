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
  createProject(input: { name: string; client: string; goal: string }): Promise<string | null>;
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

  async createProject(input) {
    try {
      // 契约:POST /api/projects → { project: ProjectSummary }(201)。
      // 详情要另拉 —— selectProject 会去打 messages,详情页自己打 getProject。
      const { project } = await api.createProject(input);
      await get().loadProjects();
      set((s) => ({ projectsRevision: s.projectsRevision + 1 }));
      await get().selectProject(project.id);
      return project.id;
    } catch (e) {
      set({ error: { code: "project_create_failed", message: errorMessage(e) } });
      return null;
    }
  },

  sendMessage(text) {
    const { projectId, socket } = get();
    if (!projectId || !socket) return;
    const t = newTurn(`u_${Date.now().toString(36)}`, "user");
    set((s) => ({ turns: [...s.turns, { ...t, blocks: [{ kind: "text", text }] }] }));
    socket.sendToProject(projectId, text);
  },

  sendInterrupt() {
    const { projectId, socket } = get();
    if (!projectId || !socket) return;
    socket.interrupt(projectId);
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
