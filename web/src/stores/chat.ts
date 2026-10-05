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
 * WS 推来的 `work_changed` / `client_question` 只带增量
 * (一句 status / 一个 id),不带完整视图。store 因此**不自己拼数据**,只递增
 * `projectRevision` / `projectsRevision`,让页面按需回查 `GET /api/...` 拿权威数据。
 * 这样前后端不会有两份会漂移的真相。
 */
import { create } from "zustand";
import {
  eventProjectId,
  type MessageOrigin,
  type ProjectSummary,
  type ServerEvent,
  type SessionMessageView,
  type TurnTriggerKind,
  type WsToolInfo,
} from "@shared/types/platform";
import * as api from "../lib/api";
import { invalidateHarnessCache } from "../lib/data";
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

/**
 * **这一轮是从哪个封套建出来的**(设计 1 §2.10 的通道分离,W2-④)。
 *
 * ⚠️ **W3-① 起它不再是前端自己的类型** —— 它就是契约里的
 * `MessageOrigin`(`shared/types/platform.ts`)。原因:落库行也要带同一个形状
 * (`SessionMessageView.origin`,migration 019),而那两处若各写一份,「刷新之后
 * 判据消失」那个 bug 会以「两份形状漂开」的形式**复发**。现在:
 *
 *   - 实时流:`originOfMessageStart` 读 `message_start` 的 `source` / `trigger`;
 *   - 刷新回填:`SessionMessageView.origin` **直接就是**这个类型;
 *   ⇒ 两条路产出同一个形状,`channelOf` 只认它一个。
 *
 * 两个维度合成一个字段,**不是两个平铺字段**:
 *
 *   - `source: "turn"` —— 回合封套(`TurnMessageStart`)。它**必须**带
 *     `trigger`(这一轮为什么存在)。
 *   - `source: "broadcast"` —— 播报封套(`BroadcastMessageStart`,`tell_client`
 *     投递给甲方的那条独立消息)。它**没有** `trigger`,而且是结构性的:
 *     播报无条件显示,不能被任何「回合级」判据连坐。
 *   - `source: "unknown"` —— **判据缺失**(不是「内部」)。两个来源:
 *     ① REST 回填一条 **019 之前写入的存量行**(那两列当时没被记录);
 *     ② `tool_start` 抢先建轮(`message_start` 还没到)。
 *
 * ── 为什么把 `trigger` 嵌进 `source` 而不是平铺两个字段 ──────────────
 *
 * 与契约同一条纪律:`{ source: "broadcast"; trigger: … }` 这种组合在**线上**
 * 根本不可能存在(`_BroadcastMustNotCarryTrigger` 是契约里的编译期断言)。
 * 平铺两个可空字段就等于把那个不可能的态重新变得可写 —— 而它一旦被写出来,
 * 「播报的显示判据」就又能被 `trigger` 顺手判错一次。这里让它**编译不过**。
 *
 * ── 为什么 `"unknown"` 是一个**显式取值**,而不是 `null` ─────────────
 *
 * 折成 `null` 之后 `channelOf` 里一个 `??` 或一次 `if (!origin)` 就会把
 * 「没有判据」静默当成某一侧 —— 而两条通道各错一次都要出人命(见 `channelOf`
 * 的说明)。第三个取值强制每一个读者显式表态。
 *
 * ── `trigger` 只有 `kind` 一维(不是 `TurnTrigger`)──────────────────
 *
 * `todoKind` 不参与通道判定、前端也没有第二个读者(见下面 `isTurnTriggerKind`
 * 的说明),所以共享类型把它收在 `TurnTriggerKind` 上 —— 落库的
 * (`trigger_kind`)与前端读的因此是**同一个形状**,不必再抄一份 11 个取值的
 * 闭合集到前端来。
 */
export type TurnOrigin = MessageOrigin;

export interface Turn {
  /** = 后端那条消息的 `messageId`(轮表的键,见 `ChatState.inFlight`)。 */
  id: string;
  /**
   * 这一轮属于哪个**上下文**。取值域与 `message_start` / `tool_start` 信封上的
   * `projectId` 逐字同义:**`null` = 接待会话**(不是「没有项目」)。
   *
   * 为什么轮必须自己记着它(而不是从 store 的 `projectId` 推):一条 WS 连接上
   * 跑着**所有**项目的事件(`hub.broadcast()` 向所有连接扇出,不按项目过滤),
   * 而 `agent_end` 要 flush 的只能是**它自己那个上下文**的轮 —— 见下面
   * `ChatState.inFlight` 里记的那条跨项目截断。
   */
  projectId: string | null;
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
   * A2 只负责**存**(两个能建轮的事件 + REST 回填那条路径);过滤与标注是 A3 的活,
   * 而 **A3 已经落地**:`web/src/lib/data.ts` 的 `channelOf` 用它做两跳判定
   * (`agentId → 成员 role → clientFacing`),`MessageList` 据此把轮分到
   * 甲方通道 / 内部通道并显示被滤掉的条数。
   *
   * ⚠️ **W2-④ 起它不再是主判据** —— `channelOf` 现在先看 `origin`(这一轮
   * 为什么存在 / 这个封套是谁发的),`agentId` 只用来答「是不是甲方自己说的」;
   * 角色的 `clientFacing` 两跳退化成 `origin === unknown` 时的回退(见 `origin`)。
   */
  agentId: string | null;
  /**
   * 这一轮是从哪个封套建出来的(见 `TurnOrigin`)。**建轮那一刻定盘** ——
   * `delta` / `message_end` 不带这两维(与 `agentId` 同一条纪律,设计 1 §2.10.2)。
   *
   * 判据是**「为什么有这一轮」与「这个封套是谁发的」两个正交维度**,不是「谁在
   * 说话」:`worker` 被工件叫醒的那一轮、业务经理被 `report_downstream` 叫醒的
   * 那一轮,说话人没变(`agentId` 照旧),但**正文不是对甲方说的话**。
   */
  origin: TurnOrigin;
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
  /**
   * **运行态**的 revision —— 成员页「正在做什么」区与工件页 DAG 的在跑标记据此回查。
   *
   * 为什么与 `projectRevision` 分开:那一位是一个**粗**信号(任何项目里一个回合
   * 结束都推它),而它带的读者会重拉整个项目的工件 / 对话 / 工作项。运行态要的
   * 是**立刻**跟着 `message_start` / `tool_start` / `agent_end` 动 —— 把它挂在
   * projectRevision 上等于让每一个工具调用触发一次全项目重拉。
   *
   * ⚠️ 它**不是**「现在有没有人在跑」的真相,**只是一个『去查一下』的敲门砖**:
   * 真相永远来自 `GET /api/projects/:id/live`(见 `lib/data.ts` 的
   * `useProjectLive`)。WS 会断,库与宿主不会。
   */
  activityRevision: number;
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
   * - `agent_end` 才把**它自己那个上下文**的轮按开始顺序一起 flush 进 `turns`
   *   (判据是 `turn.projectId === e.projectId` 的**恒等比较** —— 见下面那条
   *   跨项目截断;`null` = 接待会话,是一个真上下文,不是「通配」)。
   *
   * ── 为什么每轮都要记 `projectId`(bug②,实测)────────────────────────
   *
   * `appSocket.ts` 把这条连接上的**全部**事件无条件灌进 store,而
   * `hub.broadcast()` 是向所有连接扇出、**不按项目过滤**的。于是「用户坐在项目 A
   * 看它流」与「排空器在项目 B 跑 pm/qa」共用同一条事件流,修前的 `agent_end`
   * **把整张表一起 flush**(不看到底是谁的回合):
   *
   *     A message_start(a1) → A delta(a1,"前半")
   *     B message_start(b1) → B delta(b1,"B 的产出")
   *     B agent_end        ⇒ a1 被 flush 出表 + inFlight 清空
   *     A delta(a1,"后半") ⇒ 表里没有 a1 ⇒ **整段丢字(A 被截断)**
   *
   * 丢字发生在**数据层**(`delta` 按 `messageId` 认领、找不到就丢 —— §2.10.3
   * 「不猜角色」的同一条纪律),**渲染层救不了**:从没进过 `inFlight` 的 delta
   * 没有任何地方能补回来。
   *
   * ⚠️ **它不是 A2 引入的**:单槽时代 `delta` 的守卫是
   * `const cur = get().currentTurn; if (!cur) return;`(`git show b5dac9b^:`
   * 第 363-364 行),B 的 `agent_end` 把 `currentTurn` 置 null 之后,A 的迟到
   * delta 同样被丢。A2 改变的是「一次 `agent_end` 能 flush 几轮」—— 那个 N
   * 现在**可以跨项目**。
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
   * 它**不是**存储 —— 存储是上面的 `inFlight`。
   *
   * ⚠️ **今天它在 `web/src/` 里没有读者**(A2 写下这段时说「渲染层只读这一个
   * 字段」,而 A3 已经落地:`components/chat/MessageList.tsx` 现在消费
   * `inFlightTurns()` 并把结果过一遍 `partitionTurns`,不再看这个指针)。
   * 保留并继续维护它有两个理由:
   *   1. `web/src/stores/chat.ts` 之外仍有测试在读它;
   *   2. 一个**指向已收口那一轮**的指针是比 `null` 更难查的错 —— 所以 `agent_end`
   *      只在它指向的轮真的被收口时交接(见那个分支)。
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

const newTurn = (
  id: string,
  role: Role,
  agentId: string | null,
  projectId: string | null,
  origin: TurnOrigin,
): Turn => ({
  id,
  projectId,
  role,
  blocks: [],
  startedAt: Date.now(),
  isStreaming: false,
  agentId,
  origin,
});

/**
 * `message_start` 上的**两维一次读完**,并在这里把「封套没到」与「封套说自己是
 * 播报」分开(设计 1 §2.10 的 W2-④)。
 *
 * 写成函数(而不是散在 `applyEvent` 里一个三元)是为了给**漏填**一个响亮的现场。
 * 契约上这两维是必填,`tsc` 会把 `src/` 的每个构造点都点出来 —— 但 `tests/**`
 * **完全不参与 typecheck**(两条 tsconfig 的 include / exclude,见 AGENTS.md),
 * 于是一个手搓的夹具漏填 `trigger` 时:
 *
 *   - 旧形状:`channelOf` 读 `origin.trigger.kind` ⇒ 一句 `Cannot read properties
 *     of undefined` —— 现场里看不出是哪条契约字段漏了(与 7-D/7-M「不要惩罚不
 *     携带错误信息的偏差」相反);
 *   - 更糟的形状:静默降级成 `unknown` ⇒ 那一轮**悄悄走回退判据**,测试照样绿。
 *
 * 所以这里**抛**(fail loud):本项目对「不可能发生、而猜错会静默判错」的处理
 * 就是抛(`views.ts` 的 `usageAgentOrThrow`、`organize` 的 `channel.ask` 同款)。
 * 真实运行路径上它不可能触发:四个发射点都在 `src/` 里,受 `tsc` 约束。
 */
/**
 * `TurnTriggerKind` 的 module-level 类型守卫(与 `ToolCallCard` 的 `hasContentArray`
 * 同款约定:不用断言糊过去)。
 *
 * 只验**参与判定的那一维** `kind`:`todoKind` 是闭合集,但它既不参与通道判定、
 * 也不被前端读取 —— 在这里再抄一份闭合集就是第三处真相(AGENTS.md「派生值上到
 * 线上就是第二处真相」)。**W3-① 起这条收窄不再是「前端自己的选择」**:
 * 落库的 `trigger_kind` 存的**就是**这一维,所以下面 REST 回填那条路与这里
 * 读的是同一个形状(`MessageOrigin` 的 `trigger: { kind }`)。
 */
function isTurnTriggerKind(value: unknown): value is TurnTriggerKind {
  return value === "user" || value === "todo";
}

function originOfMessageStart(e: { source?: unknown; trigger?: unknown }): TurnOrigin {
  const source = e.source;
  if (source === "broadcast") {
    // 播报封套**不带** `trigger`(契约里的编译期断言 `_BroadcastMustNotCarryTrigger`)。
    // 带了也不影响判定 —— 播报无条件显示 —— 所以这里不把它当错误。
    return { source: "broadcast" };
  }
  const kind =
    typeof e.trigger === "object" && e.trigger !== null
      ? (e.trigger as { kind?: unknown }).kind
      : undefined;
  if (source !== "turn" || !isTurnTriggerKind(kind)) {
    throw new Error(
      "message_start 缺 source / trigger:契约里这两维是必填(shared/types/platform.ts 的 " +
        "TurnMessageStart / BroadcastMessageStart)。夹具漏填或版本错配 —— 静默降级会让" +
        "这条线按回退判据悄悄上屏,所以这里不降级。",
    );
  }
  // **只取 `kind`**(见 `isTurnTriggerKind` 的说明):`todoKind` 不参与判定,
  // 而落库那条路根本拿不到它 —— 两条路必须产出同一个形状。
  return { source: "turn", trigger: { kind } };
}

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
 * A2 交出去的那两件事**A3 已经落地**,今天的读者是
 * `components/chat/MessageList.tsx`:
 *   1. 它把 `inFlightTurns(...)` 的结果接在 `turns` 之后渲染(不再是单槽
 *      `currentTurn`)—— §2.10.3「流式期间同时看到两轮」在屏幕上成立;
 *   2. 它把那一段也过一遍 `partitionTurns(turns/live, ctx)`,`ctx` 由
 *      `agentId → 成员 role → /api/harness 的 clientFacing` 两跳算出
 *      (`web/src/lib/data.ts` 的 `channelOf`),被滤掉的条数如实显示。
 *
 * ⚠️ 它**只按开始顺序返回** —— 不替调用方决定「非甲方轮在甲方视图里留不留」
 * (§2.10.4 那条决定在渲染层,由 `partitionTurns` 承担)。
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
 *
 * ── ✅ **`origin` 不再是 `unknown`(W3-① 已闭合)**────────────────────
 *
 * 这里曾经**只能**给 `{ source: "unknown" }`:库里没落那两维,`SessionMessageView`
 * 上也就没有 ⇒ 刷新之后判据消失 ⇒ `channelOf` 走回退(按角色两跳,fail-open)
 * ⇒ **业务经理被工件/待办叫醒的那一轮正文,刷新一次又出现在对话页上**
 * (流式那条路是对的,两条路不一致,而界面上看不出来)。
 *
 * 现在 `SessionMessageView.origin` **就是** `MessageOrigin`(migration 019 把
 * 封套落进了 `session_messages.origin_source` / `trigger_kind`)⇒ 这里**照抄**,
 * 不猜、不编:
 *
 * ```ts
 * origin: m.origin,   // 而不是 { source: "unknown" }
 * ```
 *
 * **两条路因此是同一个判据**:实时流读 WS 封套(`originOfMessageStart`),
 * 刷新读库里的同两维(`toMessageView` → `messageOriginOf`)—— 两侧的形状是
 * 同一个类型(`MessageOrigin`),所以「一边改了另一边没改」编译期就会红。
 *
 * ⚠️ **`unknown` 仍然存在,不是死代码**:019 之前写入的存量行那两列是 `NULL`
 * (当时没有记录,回填就是编造),它们照样落到 `unknown` 上,由 `channelOf` 的
 * 回退判据兜住 —— 见 `web/src/lib/data.ts` 的第 5 步。
 *
 * `projectId` 由调用方给:回填那条路径自己知道拉的是谁的对话
 * (`selectProject(id)` 给 `id`,`loadIntakeMessages()` 给 `null`)——
 * **不从 `Turn` 之外的地方猜**。
 */
function messageToTurn(m: SessionMessageView, projectId: string | null): Turn {
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
    projectId,
    role,
    blocks,
    startedAt: m.createdAt,
    endedAt: m.createdAt,
    isStreaming: false,
    agentId: m.agentId,
    origin: m.origin,
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
  activityRevision: 0,

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
        turns: (res.messages ?? []).map((m) => messageToTurn(m, id)),
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
        turns: (res.messages ?? []).map((m) => messageToTurn(m, null)),
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
    // 这一轮属于**当前上下文**(接待会话 = null)—— 乐观上屏这一轮不进
    // `inFlight`,所以 `projectId` 在这里只做「这条轮属于哪段对话」的如实标注。
    //
    // `origin` 是 **`trigger.kind === "user"` 的正样本**:这是甲方亲口发起的那一轮,
    // 它当然进甲方通道(与 server 回显那条 `message_start(user)` 同源)。
    const t = newTurn(
      `u_${Date.now().toString(36)}`,
      "user",
      null,
      intakeActive ? null : projectId,
      { source: "turn", trigger: { kind: "user" } },
    );
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
      // 运行态的 revision 一起归零:重置之后屏幕上那份「正在做什么」没有意义了。
      activityRevision: 0,
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
        // `projectId` 同样只在这里落一次:认领靠 `messageId`,而**收口要靠它**。
        //
        // ⚠️ **W2-④:这里同时落 `origin`(两维一起)** —— 建轮那一刻定盘,与
        // `agentId` / `projectId` 同一个位置。`delta` / `message_end` 不带这两维,
        // 所以之后再没有第二次机会。**必须先过 `originOfMessageStart`**:
        // 一个漏填的夹具在这里**抛**(不是静默降级),否则 `channelOf` 会读到一个
        // 没有 `trigger` 的 `origin` —— 那正是 W1-① 警告的那个 TypeError。
        const origin = originOfMessageStart(e);
        set((s) => ({
          ...withTurn(s, {
            ...newTurn(e.messageId, "assistant", e.agentId, e.projectId, origin),
            isStreaming: true,
          }),
          status: "streaming",
          error: null,
          // 「有人在跑」这件事要**立刻**反映到成员页 / 工件页的运行态上:
          // 建轮这一刻正是它从「空闲」变「在跑」的时刻。跨项目的轮不在这里刷
          // (恒等比较,与 `inFlight` 的收口判据同粒度)。
          activityRevision:
            e.projectId === s.projectId ? s.activityRevision + 1 : s.activityRevision,
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
        // **上下文同理**(`projectId` 跟着已有轮走)—— 否则一个只由 tool_start
        // 建出来的轮会在 `agent_end` 时被当成「别人家的」而漏收口。
        //
        // ⚠️ **`origin` 同理:跟着已有轮走。** 由 `tool_start` **从头**建出来的轮
        // 只能拿到 `{source:"unknown"}` —— 这个封套上根本没有那两维(契约有意为之:
        // 它们是**建轮**那一刻定的,不是每个事件都抄一遍)。真实路径上它不出现
        // (`serve.ts` 的 `emitMessageStart` 总在 `runTurn` 之前),只可能是
        // 「中途接上来的连接」或测试里的孤轮 —— 那时按 `channelOf` 的回退判据处置,
        // 而不是在这里猜一个 `trigger`。
        const t =
          get().inFlight[e.messageId] ??
          newTurn(e.messageId, "assistant", e.agentId, e.projectId, { source: "unknown" });
        set((s) => ({
          ...withTurn(s, { ...t, blocks: [...t.blocks, { kind: "tool", tool: e.tool }] }),
          // 「他最后一次动手是什么工具」在运行态里是一个要显示的事实 —— 工具一开始
          // 就要刷(而不是等回合结束),否则一个 16 分钟的长回合里那一格永远是旧的。
          activityRevision:
            e.projectId === s.projectId ? s.activityRevision + 1 : s.activityRevision,
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
        // 整张轮表按**开始顺序**flush,但**只 flush `e.projectId` 那个上下文的轮**
        // —— 一条 WS 连接上跑着所有项目的事件(见 `ChatState.inFlight` 里记的
        // bug② 现场)。判据是恒等比较:`null`(接待会话)是一个真上下文,
        // **不是通配**;所以别的项目的 `agent_end` 既清不动本项目正在流的轮,
        // 也不会被本项目的 `agent_end` 顺手清掉。
        set((s) => {
          const mine = inFlightTurns(s).filter((t) => t.projectId === e.projectId);
          const finished = mine.map((t) => ({
            ...t,
            endedAt: Date.now(),
            isStreaming: false,
          }));
          const flushed = new Set(mine.map((t) => t.id));
          const kept = {
            inFlight: Object.fromEntries(
              Object.entries(s.inFlight).filter(([id]) => !flushed.has(id)),
            ),
            inFlightOrder: s.inFlightOrder.filter((id) => !flushed.has(id)),
          };
          const stillLive = inFlightTurns(kept);
          return {
            turns: finished.length > 0 ? [...s.turns, ...finished] : s.turns,
            ...kept,
            // 兼容指针只在**它指向的轮真的被收口**时交接:`withTurn` 的语义是
            // 「最近一次被写入的进行中轮」,所以交接给还活着的那一轮(没有才 null)。
            // 直接置 null 会让别的项目收口把本项目的指针打空 —— 与「清空轮表」
            // 是同一个错的两种叫法。
            currentTurn: stillLive.length > 0 ? (stillLive[stillLive.length - 1] ?? null) : null,
            // **还有回合在流时不许回到 idle**:`ChatSurface.tsx:112` 的发送键正是
            // `status === "streaming"` 才禁用,别的项目一收口就解锁发送,等于允许
            // 用户在本项目还在推演时再发一句;顶部「推演中」(同文件 :90)也吃这个值。
            status: stillLive.length > 0 ? "streaming" : "idle",
            // 一轮结束 = 工作项 / 工件大概率被改过 —— 让页面回查。
            // (两个 revision 仍然无条件推:排空器改的可能是**别的**项目,
            //  左栏徽标与项目详情都该有机会回查。)
            projectRevision: s.projectRevision + 1,
            projectsRevision: s.projectsRevision + 1,
            // 一个回合收口 ⟹ 谁在跑 / 最后活动 / 待办都变了(排空器可能立刻接上
            // 下一个角色)。跨项目的收口不刷这一屏。
            activityRevision:
              e.projectId === s.projectId ? s.activityRevision + 1 : s.activityRevision,
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
        // ⚠️ **工具面带上下文**:接待阶段(project = null)与项目内同一角色的工具面
        // 不一样(scope 门)。而这份判据是**标签页级缓存**的 ⇒ 不失效的话,用户立完
        // 项之后打开成员页,看到的仍是「接待阶段」那一份(某些角色是 0 个工具),
        // 而它看起来完全正常。
        invalidateHarnessCache();
        set((s) => ({ projectsRevision: s.projectsRevision + 1 }));
        if (onIntake) void get().selectProject(e.projectId);
        return;
      }

      case "client_question":
      case "client_question_answered":
      case "work_changed":
      case "blocker_changed": {
        // 事件只是「有变更」的信号,真值回查后端(见文件头)。两个戳分开是有意的:
        // 别的项目来了一个问题 → 左栏徽标该动,但当前项目的详情不该重拉。
        //
        // ⚠️ `artifact_created` **曾经**在这个 case 组里 —— 它被删掉是因为
        // `hub.emitArtifactCreated` **零调用方**(B3 实测):这条分支从来不会到达,
        // 而它做的事与 `agent_end` 逐字相同(两个 revision 都 +1)⇒ 接上它也不会
        // 产生任何可观察差异。删「照不到的分支」,不删契约里的类型(见报告)。
        const pid = eventProjectId(e);
        const active = get().projectId;
        set((s) => ({
          projectsRevision: s.projectsRevision + 1,
          projectRevision: s.projectRevision + (pid === null || pid === active ? 1 : 0),
          // `work_changed` 会改变「他手上正在做的事」,所以运行态也要刷
          // (`artifact_created` / `client_question` 那几个不影响它,但仍然无害 ——
          //  这几位都在同一个 case 组里,判据是「当前上下文」)。
          activityRevision:
            pid === null || pid === active ? s.activityRevision + 1 : s.activityRevision,
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
          // 排空器**停下了** —— 这正是运行态最需要立刻显示的一件事(它从「有回合
          // 在跑」变成「没人再被叫醒」),所以这一位也要推。
          activityRevision:
            pid === null || pid === active ? s.activityRevision + 1 : s.activityRevision,
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
