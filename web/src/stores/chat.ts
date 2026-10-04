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
  /** = 后端那条消息的 `messageId`(轮表的键,见 `ChatState.inFlight`)。 */
  id: string;
  role: Role;
  blocks: Block[];
  startedAt: number;
  endedAt?: number;
  usage?: { input: number; output: number };
  isStreaming?: boolean;
  /**
   * 谁在说话。**`null` = 甲方** —— 与 `message_start.agentId` /
   * `tool_start.agentId` / `SessionMessageView.agentId` /
   * `session_messages.agent_id` 四处**逐字同义**,不新造取值域。
   *
   * A2 只负责**存**(两个能建轮的事件 + REST 回填那条路径);**过滤与标注是 A3 的活**
   * —— 今天它在渲染层没有读者(见本文件末 `inFlightTurns` 的注释)。
   */
  agentId: string | null;
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
  /** 已收口的轮(会话消息 + 每个 `agent_end` flush 出来的进行中轮)。 */
  turns: Turn[];
  /**
   * **进行中的轮表,键 = `messageId`**(设计 1 §2.10.3 的修法)。
   *
   * ── 为什么不能只有一个槽 ─────────────────────────────────────────
   *
   * 后端一个回合里可以**并发存在多条消息**:业务经理「先说话 → 调 `tell_client`
   * 播报 → 再说话」时,播报会在回合**内部**发一整套独立信封
   * (`hub.ts` 的 `message_start(msgB)` + `delta` + `message_end`,`tools/client.ts`
   * 里是 `await`)—— 而 `msgA` 的正文还没流完。只有**一个** `currentTurn` 槽时,
   * `message_start(msgB)` 直接把它覆盖掉,随后回来的 `delta(msgA, 后半段)`
   * 没有 `messageId` 校验、就往 `msgB` 上追加 ⇒ **前半段正文从没进过任何一轮**,
   * 而刷新后 REST 又给出两条独立消息 ⇒ 流式视图与刷新后视图不一致,
   * 且「少了半段」在界面上看不出来(§2.10.3 探针,修复前实测)。
   *
   * ── 语义 ────────────────────────────────────────────────────────
   *
   * - **建轮**只有两处:`message_start(role: "assistant")` 与 `tool_start`
   *   (后者带 `agentId`,设计 1 §2.10.2)—— 身份在建轮那一刻就定了。
   * - `delta` / `thinking_delta` / `message_end` / `tool_end` **只找它自己那个
   *   `messageId`**;**找不到就丢**(沿用「不猜角色」纪律:猜错角色是把用户的话
   *   永久写成助手消息,丢一个 delta 最多少几个字)。
   * - `message_end` 只**收口**自己那一轮(`isStreaming: false` + usage),
   *   **不移出轮表** —— 同一回合后面还可能有它的迟到 delta(§2.10.3 的探针里
   *   `delta(msgA,"BBB")` 就在 `message_end(msgB)` **之后**)。
   * - `agent_end` 才把整张表按开始顺序一起 flush 进 `turns`。
   */
  inFlight: Record<string, Turn>;
  /**
   * 进行中轮的**开始顺序**。
   *
   * `Record` 自己没有顺序,而 `agent_end` flush 出来的次序必须稳定 ——
   * `startedAt` 是 `Date.now()`,同一毫秒内建的两轮排序会是任意的(单测里必然同毫秒),
   * 所以顺序必须显式存,不能从 `startedAt` 推。
   */
  inFlightOrder: string[];
  /**
   * **兼容指针**:最近一次被写入的进行中轮(`message_start` / `tool_start` /
   * 任一 delta / `message_end` 都会同步它)。
   *
   * 它**不是**存储 —— 存储是上面的 `inFlight`;这里留着只是因为渲染层今天
   * 只读这一个字段(`components/chat/MessageList.tsx`:`{current && <TurnView …/>}`),
   * 而 A2 **不碰渲染层**(那是 A3)。⚠️ 于是 A2 落地的这一刻,**屏幕上仍然只显示
   * 一轮** —— 数据层已经不丢字(两轮都在 `inFlight` 里、`agent_end` 后都进 `turns`),
   * 但「流式期间同时看到两轮」要等 A3 把渲染改成消费 `inFlightTurns()`。
   */
  currentTurn: Turn | null;
  /**
   * server 回显「用户自己那条消息」时用的 messageId。
   *
   * 后端对用户消息**也**广播 `message_start(user)` + `delta` + `message_end`
   * (协议是统一信封,见 `host/serve.ts`);而前端在 sendMessage 里已经把用户那句话
   * 乐观上屏了,所以 `message_start(user)` 直接 return。
   *
   * **但那个 return 曾经漏掉一件事:没记住「这个 messageId 是用户的」。**
   * 于是紧随其后的 `delta(用户原文)` 走到 `currentTurn ?? newTurn(..., "assistant")`
   * ——`currentTurn` 是 null(user 轮进了 `turns`,不在 `currentTurn`)——
   * **用户自己的话被建成一个助手轮**。
   *
   * happy path 下它只是几秒的重复显示(助手 `message_start` 到达时覆盖掉);
   * 但若这一轮在助手 `message_start` 之前失败或被中断,`agent_end` 会把这个幽灵轮
   * append 进 `turns` —— **用户的字就永久变成一条助手消息**。
   *
   * 真机证据:某轮 WS 收到的 delta 累计 543 字符 = 落库助手正文 458 + 用户那句 85。
   *
   * ── A2 之后它还需要吗:需要,但它不再是唯一的防线 ────────────────────
   *
   * 换成轮表之后,用户那条 delta **本来就找不到轮**(`message_start(user)` 不建轮,
   * 表里没有那个 `messageId`)—— 所以幽灵轮在今天已经不可能由这条路径产生。
   * 这条判断仍然**逐字保留**,理由是它记的是另一件事:**「这个 id 是甲方的」这件事
   * 本身**,与「表里有没有它」无关。保留它 = 将来若有人给 user 轮也建一条(合理需求,
   * 比如把回显用来做已送达标记),不会顺手把幽灵气泡复活。**A1 未改动它**
   * (`git show --stat 9bfad0f` 里没有 `web/src/stores/chat.ts`;它由 `f9174b5` 引入)。
   */
  lastUserEchoId: string | null;

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

const newTurn = (id: string, role: Role, agentId: string | null): Turn => ({
  id,
  role,
  blocks: [],
  startedAt: Date.now(),
  isStreaming: false,
  agentId,
});

/**
 * 轮表的**唯一写口**:写进 / 更新一条进行中的轮,并同步 `currentTurn` 兼容指针。
 *
 * 做成一个函数而不是在 7 个分支里各手写一遍,是为了让「`inFlight` 与
 * `inFlightOrder` 不会脱节」这条不变量只有一处需要维护:`isNew` 由表本身推导,
 * 调用方不可能忘记追加顺序。
 */
function withTurn(
  s: Pick<ChatState, "inFlight" | "inFlightOrder">,
  t: Turn,
): Pick<ChatState, "inFlight" | "inFlightOrder" | "currentTurn"> {
  const known = Object.prototype.hasOwnProperty.call(s.inFlight, t.id);
  return {
    inFlight: { ...s.inFlight, [t.id]: t },
    inFlightOrder: known ? s.inFlightOrder : [...s.inFlightOrder, t.id],
    currentTurn: t,
  };
}

/**
 * 进行中的轮,按**开始顺序**(渲染层在 `turns` 之后接着渲染这一段)。
 *
 * ⚠️ **这是 A2 交给 A3 的接口。** A3 要做的两件事都在渲染侧:
 *   1. `MessageList` 把 `{current && <TurnView turn={current} streaming />}`
 *      换成 `inFlightTurns(s).map(...)` —— 否则流式期间仍然只看得到**最近写入**的那一轮
 *      (§2.10.3:数据层已经不丢字,但屏幕上少那半段的观感还在);
 *   2. 用 `turn.agentId` 做过滤 / 标注(`agentId === null` = 甲方;
 *      `agentId !== null` 时去 `/api/harness` 的角色表里查 `clientFacing`)。
 *
 * A2 **不做**这两件事,也不替 A3 决定「非甲方轮在甲方视图里留不留」(§2.10.4)。
 */
export function inFlightTurns(
  s: Pick<ChatState, "inFlight" | "inFlightOrder">,
): Turn[] {
  return s.inFlightOrder
    .map((id) => s.inFlight[id])
    .filter((t): t is Turn => t !== undefined);
}

/**
 * 会话消息(后端扁平形状)→ turn。
 *
 * `kind: "tool"` 的行**没有**结构化字段(一条消息只有 content),所以这里不编造
 * 工具名 —— `name` 直接用契约里的原始 kind 值,`result` 放 content。宁可显示
 * 一个英文 kind,也不假装知道当时调的是什么工具。
 *
 * `agentId` 照抄(`SessionMessageView.agentId`,null = 甲方)—— §2.10.1 记的
 * 「拿到又丢掉」在这里收口;**用它做什么是 A3**。
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
    agentId: m.agentId,
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
  inFlight: {},
  inFlightOrder: [],
  currentTurn: null,
  lastUserEchoId: null,

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
      inFlight: {},
      inFlightOrder: [],
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
        inFlight: {},
        inFlightOrder: [],
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
      inFlight: {},
      inFlightOrder: [],
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
        inFlight: {},
        inFlightOrder: [],
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
    const t = newTurn(`u_${Date.now().toString(36)}`, "user", null);
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
      inFlight: {},
      inFlightOrder: [],
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
        //
        // ⚠️ **必须记住这个 id 再 return** —— 否则紧随其后的用户 delta 会被
        // 误建成助手轮(见 `lastUserEchoId` 的注释)。**用户消息不建轮** ——
        // 它不该出现在 `inFlight` 里(那会让渲染层多一个「推演中」的甲方气泡)。
        if (e.role === "user") {
          set({ lastUserEchoId: e.messageId });
          return;
        }
        // 建轮的唯一入口之一(另一个是 tool_start)。`agentId` 在这里落进轮里,
        // 之后就由 `messageId` 认领 —— `delta` 系列事件不带 agentId(§2.10.2)。
        set((s) => ({
          ...withTurn(s, { ...newTurn(e.messageId, "assistant", e.agentId), isStreaming: true }),
          status: "streaming",
          error: null,
        }));
        return;
      }
      case "delta": {
        // ① 已知是 server 对用户消息的回显 —— 乐观上屏时显示过了,不能再建一条。
        //    (轮表之后它本来也找不到轮;保留见 `lastUserEchoId` 的注释。)
        if (e.messageId === get().lastUserEchoId) return;
        // ② **按 messageId 认领**。找不到就意味着没人宣布过这条消息 —— 与
        //    「不猜角色」是同一条纪律:原实现是 `?? newTurn(e.messageId, "assistant")`,
        //    **它替 server 猜了一个角色**,而猜错的代价是用户自己的话被冒充成助手
        //    (真机踩过)。丢一个 delta 最多少几个字。§2.10.3 的另一半就在这一行:
        //    没有这行校验,`delta(msgA, 后半段)` 会追加到**别人**(msgB)那一轮上。
        const cur = get().inFlight[e.messageId];
        if (!cur) return;
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: last.text + e.text };
        else blocks.push({ kind: "text", text: e.text });
        set((s) => ({ ...withTurn(s, { ...cur, blocks, isStreaming: true }), status: "streaming" }));
        return;
      }
      case "thinking_delta": {
        // 推理与正文是两条流,永不混流(契约注释里的 7-I 现场)。这里靠 block
        // 的 kind 分开累积 —— 与正文各自的「最后一个同类块」拼接。
        //
        // ⚠️ **与 delta 分支逐字平行、但不合并成一个函数**:两条流的判据一旦被
        // 「抽公共」抽错(比如把 kind 当成参数传),7-I 就会回来 —— 那次是
        // 1853 字符内部推理被当成正式回复展示给甲方。
        if (e.messageId === get().lastUserEchoId) return;
        const cur = get().inFlight[e.messageId];
        if (!cur) return;
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "thinking") {
          blocks[blocks.length - 1] = { kind: "thinking", text: last.text + e.text };
        } else {
          blocks.push({ kind: "thinking", text: e.text });
        }
        set((s) => ({ ...withTurn(s, { ...cur, blocks, isStreaming: true }), status: "streaming" }));
        return;
      }
      case "tool_start": {
        // `tool_start` **自己也能建轮**(设计 1 §2.10.2 表格第 2 行)—— 它是
        // `agentId` 的另一个构造点。已有该 messageId 的轮时**不覆盖身份**:
        // 身份在建轮那一刻就定了,`tool_start` 不该改写消息的作者。
        const t = get().inFlight[e.messageId] ?? newTurn(e.messageId, "assistant", e.agentId);
        set((s) => ({
          ...withTurn(s, { ...t, blocks: [...t.blocks, { kind: "tool", tool: e.tool }] }),
        }));
        return;
      }
      case "tool_end": {
        // 只更新**它自己那个 messageId** 的那一轮里的那张工具卡。找不到就丢。
        const cur = get().inFlight[e.messageId];
        if (!cur) return;
        const blocks = cur.blocks.map((b) =>
          b.kind === "tool" && b.tool.id === e.tool.id ? { kind: "tool" as const, tool: e.tool } : b,
        );
        set((s) => ({ ...withTurn(s, { ...cur, blocks }) }));
        return;
      }
      case "message_end": {
        // **只收口它自己那一轮**(§2.10.3 验收判据)。两条边界:
        //   ① 找不到这一轮 → 丢(不猜、不新建);
        //   ② **收口 ≠ 移出轮表** —— 同一回合后面还可能有它的迟到 delta,
        //      §2.10.3 的探针里 `delta(msgA,"BBB")` 就落在 `message_end(msgB)` 之后。
        //      真正把轮移出表的是 `agent_end`。
        const cur = get().inFlight[e.messageId];
        if (!cur) return;
        const usage = e.usage;
        set((s) => ({
          ...withTurn(s, { ...cur, isStreaming: false, usage: usage ?? cur.usage }),
          currentUsage: {
            input: s.currentUsage.input + (usage?.input ?? 0),
            output: s.currentUsage.output + (usage?.output ?? 0),
          },
        }));
        return;
      }
      case "agent_end": {
        // 整张轮表按**开始顺序**flush —— 一个回合里可以有多条消息(§2.10.3 的
        // 现场就是两条),单槽时代这里只能 append 一条。
        set((s) => {
          const finished = inFlightTurns(s).map((t) => ({
            ...t,
            endedAt: Date.now(),
            isStreaming: false,
          }));
          return {
            turns: finished.length > 0 ? [...s.turns, ...finished] : s.turns,
            inFlight: {},
            inFlightOrder: [],
            currentTurn: null,
            status: "idle",
            // 一轮结束 = 工作项 / 工件大概率被改过 —— 让页面回查。
            projectRevision: s.projectRevision + 1,
            projectsRevision: s.projectsRevision + 1,
          };
        });
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
