/**
 * 传输层 · WS 枢纽
 *
 * ── 它是什么 ────────────────────────────────────────────────────
 *
 * 一个进程内的广播点:所有浏览器连接登记在这里,服务端事件从这里扇出。
 * 它同时是 `ClientChannel` 的真实实现 —— 也就是说,业务经理调 `ask_client`
 * 时,那条问题**经由这里**到达用户屏幕。
 *
 * 旧系统对应物是 `kernel.attachSink` + `wss` 的组合,但那时 sink 被捕获进
 * kernel 闭包,于是**首个连接的死亡会切断所有输出**(旧代码注释里的 S1/A7
 * 记着这个事故)。这里用集合 + 逐连接发送,某个连接死了只影响它自己。
 *
 * ── 为什么事件要带 projectId ─────────────────────────────────────
 *
 * 「按项目分组呈现」是经校准的裁决:项目即上下文容器,用户切项目 = 切上下文。
 * 所以前端拿到一条事件时,必须能判断它属于哪个项目 —— 否则多项目并行时
 * 两条流会混在一起。
 *
 * ── `tell` 为什么落库 ────────────────────────────────────────────
 *
 * `tell_client` 是播报,**不替代落库** —— 这是 `business_manager.protocol`
 * 里明写的规则(「播报过的话在会话里、在甲方的记忆里,但不在项目上」)。
 * 所以播报同时做两件事:写一条 session message(项目活过会话),广播三个事件
 * (用户立刻看见)。只广播不落库的话,刷新页面它就没了。
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type Database from "better-sqlite3";
import type { ClientChannel, ClientQuestion } from "../client/port.js";
import { getArtifact } from "../storage/repo/artifacts.js";
import {
  listSessions, insertSession, appendSessionMessage, findSessionByChannel,
  type SessionChannel,
} from "../storage/repo/sessions.js";
import { getProjectRow } from "../storage/repo/projects.js";
import { toClientQuestionView, toTurnUsageView, toWorkView } from "./views.js";
import { getAgent, listAgents } from "../storage/repo/agents.js";
import { ROLE_SPECS } from "../identity/role.js";
import type { TurnUsageRow } from "../storage/repo/usage.js";
import type {
  ClientCommand, ClientQuestionView, ServerEvent, TriggerTodoKind, TurnTrigger, WsToolInfo,
} from "@shared/types/platform.js";
import type { TodoKind } from "../runtime/dispatcher.js";

// ── 契约副本的**编译期对账** ────────────────────────────────────
//
// `shared/types/platform.ts` 的 `TriggerTodoKind` 是 `runtime/dispatcher.ts` 的
// `TodoKind` 的**逐字副本**,不是 import:契约面(`shared/`)不得反向依赖 `src/`
// —— 连 type-only 都会把 runtime(及其 `better-sqlite3`)拖进 web 的类型程序
// (`tsconfig.web.json` 只 include `web/src` 与 `shared/`)。
//
// 副本会漂,所以这里放一对**双向互相可赋值**的断言。它**只可能落在 server 侧**
// (契约面自己看不见 `TodoKind`),而落在 transport 是因为这里正是「runtime 的
// 待办种类 → 契约的 `trigger.todoKind`」那个接缝。
//
// 负样本(已实跑):从契约的 `TriggerTodoKind` 里删掉 `"handover"`
// ⇒ `Type 'false' does not satisfy the constraint 'true'.`;加回来 ⇒ 0 error。
type AssertTrue<T extends true> = T;
type MutuallyAssignable<A extends string, B extends string> =
  [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _TodoKindParity = AssertTrue<MutuallyAssignable<TodoKind, TriggerTodoKind>>;

export interface HubDeps {
  readonly db: Database.Database;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
}

export interface HubHandlers {
  /**
   * 用户在一个项目(或**接待会话**,`null`)里说了句话 —— host 负责建会话 / 跑回合。
   */
  readonly onUserMessage: (projectId: string | null, content: string) => Promise<void>;
  /** 用户答了一个 client_question */
  readonly onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
  readonly onInterrupt: (projectId: string | null) => void;
}

export class PlatformHub {
  private readonly clients = new Set<WebSocket>();
  /**
   * **常驻会话的忙闩 —— 键是 `(上下文, agent)`,不是上下文。**
   *
   * ── 它保护的到底是什么 ──────────────────────────────────────────
   *
   * 「**一条常驻会话**不能被两条流同时写」—— `host/serve.ts` 的 `runAgentTurn`
   * 自己写着「两条流打在同一条常驻会话上就是一次真正的竞态」。而常驻会话的键
   * 就是 `(上下文, agent)`(四个角色各一条:工具面 / 提示词不同),所以闩的键
   * 必须与它**同粒度**。按项目记的时候:worker 在跑 ⇒ 整个项目算忙 ⇒ 甲方
   * **发不出话**,而他要找的是业务经理那条会话 —— 与 worker 那条根本不是同一条。
   *
   * ⚠️ **错在「粗」,不在「方向」**:用户消息走业务经理,**排空器也会叫醒业务
   * 经理**(`report_downstream` 的 targetRole 就是它),所以「用户那条路永远与
   * 排空不撞车」是假的 —— `(上下文, agent)` 才是对的判据。
   *
   * 键的编码只在枢纽内部用(`<上下文>::<agent>`,上下文 `null` = 接待会话);
   * 对外 API 仍然收 `string | null`,不引入哨兵值(理由见旧注释:哨兵要么前后端
   * 各写一份字面量,要么得从 `@shared` 值导入 —— server 侧禁止)。
   */
  private readonly busy = new Set<string>();
  /**
   * 等着占用某个 `(上下文, agent)` 的排队者(FIFO)。
   *
   * **只有排空器会排队**(见 `acquireTurn`):它每条回合都要占用那个角色的会话,
   * 而甲方那条路正在用同一个业务经理时它必须**等**。不能改成「跳过这一回合」——
   * 排空器按回合记账(`dispatch_attempts`),跳过会被记成「叫醒过一次却没动」,
   * 三次就把那条待办的预算烧光,然后广播一条**假的** `cascade_stopped`。
   *
   * 甲方那条路**不排队**:它由 `send` 的判据直接拒掉(`code=busy`)—— 那正是
   * 验收里的负样本(「业务经理正在回你时再发一条 → 仍然被拒」)。
   */
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly deps: HubDeps,
    private readonly handlers: HubHandlers,
  ) {}

  clientCount(): number {
    return this.clients.size;
  }

  /** 闩的键(`<上下文>::<agent>`)。上下文 `null` = 接待会话。 */
  private key(projectId: string | null, agentId: string): string {
    return `${PlatformHub.contextPrefix(projectId)}${agentId}`;
  }
  /** 某个上下文里全部键的前缀。 */
  private static contextPrefix(projectId: string | null): string {
    return `${projectId ?? "<intake>"}::`;
  }

  /**
   * 这个上下文里**有没有**回合在跑;给了 `agentId` 就只看那一个角色。
   *
   * 不给 agent 的那条是**保守判据**(「这个上下文里还有活」)—— 给诊断与
   * 「整个接待会话在不在跑」的既有读者用;真正保护会话的是带 agent 的那条。
   */
  isBusy(projectId: string | null, agentId?: string): boolean {
    if (agentId !== undefined) return this.busy.has(this.key(projectId, agentId));
    const prefix = PlatformHub.contextPrefix(projectId);
    for (const k of this.busy) if (k.startsWith(prefix)) return true;
    return false;
  }

  /**
   * 占用 / 释放 `(上下文, agent)` 的回合闩。
   *
   * ⚠️ **甲方那条路的占用必须是同步的**:`send` 的忙判据与这次占用落在**同一个
   * tick** 里,否则两条挨着到的 WS 消息会双双通过判据(`handleRaw` 对每条消息
   * 各自 fire-and-forget)。`await` 一下这个缝就重新出现 —— 那正是「同一个角色
   * 两条流打进同一条会话」的入口。
   *
   * 释放时**直接把闩交给队首**(队首仍然算「忙」),而不是先清空再让排队者重新
   * 抢:后者会出现一个「闩空着」的窗口,甲方的消息可以插到一个已经排队的排空
   * 回合前面 —— 排空于是永远轮不到(饿死),而现场看起来只是「它一直没动」。
   */
  setBusy(projectId: string | null, agentId: string, v: boolean): void {
    const key = this.key(projectId, agentId);
    if (v) {
      this.busy.add(key);
      return;
    }
    const q = this.waiters.get(key);
    const next = q?.shift();
    // 交班:队首接着持有这把闩(**它仍然是「忙」**)—— 见上面「不放空」的理由
    if (q !== undefined && q.length === 0) this.waiters.delete(key);
    if (next !== undefined) {
      next();
      return;
    }
    this.busy.delete(key);
  }

  /**
   * 等到 `(上下文, agent)` 空出来再占用(排空器**每条回合**一次)。
   *
   * 返回值是释放函数 —— 语义与 `setBusy(..., false)` 完全一样(它就是这个)。
   */
  acquireTurn(projectId: string | null, agentId: string): Promise<() => void> {
    const key = this.key(projectId, agentId);
    const release = (): void => this.setBusy(projectId, agentId, false);
    // 队里已经有人时也照排 —— 否则「后到者插队」会把先到的排空饿死
    if (!this.busy.has(key) && !this.waiters.has(key)) {
      this.busy.add(key);
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      const q = this.waiters.get(key) ?? [];
      q.push(() => resolve(release));
      this.waiters.set(key, q);
    });
  }

  // ── 连接管理 ──────────────────────────────────────────────────

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));

    this.sendTo(ws, {
      type: "ready",
      modelId: null,
      provider: null,
      cwd: "",
    });

    ws.on("message", (raw: unknown) => {
      void this.handleRaw(ws, raw);
    });
  }

  private async handleRaw(ws: WebSocket, raw: unknown): Promise<void> {
    let cmd: ClientCommand;
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      cmd = JSON.parse(text) as ClientCommand;
    } catch {
      this.sendTo(ws, { type: "error", error: { code: "bad_json", message: "消息不是合法 JSON" } });
      return;
    }
    if (cmd === null || typeof cmd !== "object" || typeof cmd.type !== "string") {
      this.sendTo(ws, { type: "error", error: { code: "bad_command", message: "缺少 type" } });
      return;
    }

    try {
      switch (cmd.type) {
        case "ping":
          this.sendTo(ws, { type: "pong", ts: this.deps.now() });
          return;
        case "send": {
          // ── 忙判据的粒度是 `(项目, 收件人)`,不是项目 ──────────────────
          //
          // 这条消息的收件人是**面向甲方的那个角色**(`ROLE_SPECS.clientFacing`,
          // 今天只有业务经理 —— 见 `clientFacingAgentId`)。原来判
          // `busy.has(cmd.projectId)` 会把「worker 正在跑」也读成「业务经理忙」
          // ⇒ 甲方在与 worker 那条会话无关的通道上被拒,而他要找的人(业务经理)
          // 那条会话根本没被占。
          //
          // 反过来**必须仍然拒**:业务经理自己正在回你时(`send` 打在同一条常驻
          // 会话上)第二条要拿到 `code=busy` —— 这是负样本,证明不是「什么都不拦」。
          const to = clientFacingAgentId(this.deps.db);
          const taken =
            to !== null ? this.isBusy(cmd.projectId, to) : this.isBusy(cmd.projectId);
          if (taken) {
            this.sendTo(ws, {
              type: "error", projectId: cmd.projectId,
              error: {
                code: "busy",
                message: "与你对话的那位正在跑一个回合,等它结束或先中断",
              },
            });
            return;
          }
          await this.handlers.onUserMessage(cmd.projectId, cmd.content);
          return;
        }
        case "answer_client_question":
          await this.handlers.onAnswerQuestion(cmd.questionId, cmd.answer);
          return;
        case "interrupt":
          this.handlers.onInterrupt(cmd.projectId);
          return;
        default: {
          // 穷尽性检查:新增 ClientCommand 时这里会编译失败
          const never: never = cmd;
          this.sendTo(ws, {
            type: "error",
            error: { code: "unknown_command", message: `未知指令 ${JSON.stringify(never)}` },
          });
        }
      }
    } catch (e) {
      // 错误要带上下文。`projectId: null` 是**接待会话**;字段整个缺席是
      // 「与任何上下文无关」(如 JSON 解析失败)—— 前端据此决定弹在哪。
      const projectId =
        "projectId" in cmd && (typeof cmd.projectId === "string" || cmd.projectId === null)
          ? cmd.projectId
          : undefined;
      this.sendTo(ws, {
        type: "error",
        ...(projectId !== undefined ? { projectId } : {}),
        error: { code: "handler_failed", message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  // ── 广播 ──────────────────────────────────────────────────────

  broadcast(ev: ServerEvent): void {
    for (const ws of [...this.clients]) this.sendTo(ws, ev);
  }

  private sendTo(ws: WebSocket, ev: ServerEvent): void {
    try {
      ws.send(JSON.stringify(ev));
    } catch {
      // 写失败说明这条连接坏了 —— 摘掉它,但**不影响别的连接**
      // (旧系统的 S1/A7 事故就是 sink 被单连接捕获)
      this.clients.delete(ws);
    }
  }

  // ── 事件发射(host 与工具共用)────────────────────────────────

  /**
   * 「某条消息开始流了」——**它同时是前端唯一能建轮的事件之一**,所以
   * `agentId` 必填(见 `shared/types/platform.ts` 的 ServerEvent 说明):
   * 漏填不会报错,只会让前端把这条流当成一个**无名助手**(静默)。
   *
   * `agentId === null` = **甲方**(用户在说话),与 `session_messages.agent_id`
   * 同义。**不给默认值**是刻意的:默认值会让漏传的调用点编译通过。
   *
   * ── 为什么还要 `trigger`(2026-10-06 新增,**必填**)──────────────
   *
   * `agentId` 只答「谁在说话」,答不了「这一轮为什么存在」:排空器叫醒业务经理
   * 时说话人还是业务经理,但那一轮(`report_downstream` / `answer_ask` …)的
   * **正文不是对甲方说的话**。所以封套上必须显式带上这一轮是**谁触发的**
   * —— 与 `agentId` 同一条纪律:**不给默认值**,漏传的调用点编译不过。
   *
   * 由此发出的封套 `source` 恒为 `"turn"`(回合驱动流程)。**播报不是回合**,
   * 它走下面的 `emitBroadcastStart` —— 两者的区别是这一层唯一能判「该不该进
   * 对话页」的信息,所以不许在别处「顺手用 trigger 判一下」(播报封套上根本没有
   * `trigger`,那一支编译不过)。
   */
  emitMessageStart(
    projectId: string | null,
    messageId: string,
    role: "user" | "assistant",
    agentId: string | null,
    trigger: TurnTrigger,
  ): void {
    this.broadcast({
      type: "message_start", source: "turn", projectId, messageId, role, agentId, trigger,
    });
  }

  /**
   * **播报封套**的建轮事件 —— 只有 `clientChannel.tell` 用,所以是 private。
   *
   * 与 `emitMessageStart` 的差别只有一处,而且是**结构性**的:它不带 `trigger`
   * (类型上就不允许带,见 `BroadcastMessageStart`)。
   *
   * ── 为什么播报**不能**复用回合封套 ──────────────────────────────
   *
   * `tell_client` 是**无条件**投递给甲方的播报(它自己落库、有自己的 `messageId`),
   * 不属于任何一个回合 —— 「工件触发的汇报」那一轮里,正文该被收进内部视图,
   * 而同轮的播报该照常显示。若两者共用同一个形状,「显示与否」就只能靠
   * 回合级的 `trigger` 去猜 ⇒ 那条播报会被**连坐判掉**,而界面上少一条线是
   * 看不出来的。
   */
  private emitBroadcastStart(
    projectId: string | null,
    messageId: string,
    role: "user" | "assistant",
    agentId: string | null,
  ): void {
    this.broadcast({ type: "message_start", source: "broadcast", projectId, messageId, role, agentId });
  }
  emitDelta(projectId: string | null, messageId: string, text: string): void {
    this.broadcast({ type: "delta", projectId, messageId, text });
  }
  /** 内部推理走**独立**事件 —— 与 delta 永不混流(7-I 的现场)。 */
  emitThinking(projectId: string | null, messageId: string, text: string): void {
    this.broadcast({ type: "thinking_delta", projectId, messageId, text });
  }
  /**
   * 一条助手消息流完了。
   *
   * `usage` 的字段是 `input` / `output` / `cacheRead`(契约 2026-10-05 扩了
   * `cacheRead`;在此之前前端只累加 input+output ⇒ **缓存命中那部分完全不计**,
   * 而它恰恰是省钱的那一块)。
   *
   * ⚠️ **今天没有任何调用点传 `usage`** —— `grep -rn 'emitMessageEnd(' src/` 的
   * **六个**调用点(本文件 `tell` 那条 + `host/serve.ts` 的五处:用户回显、
   * 两条助手收尾、执行那条路的两个收尾)全是**两个实参**。也就是说前端那条
   * 「本轮 in/out」的显示**上游是空的**(2026-10-06 逐点复核;旧注释写「五个、
   * `serve.ts` 四处」,与代码不符)。本批次新增的实时通道是
   * `emitUsageRecorded`(回合级、带 `projectId`、由 `runTurn` 的
   * `onUsageRecorded` 驱动);这个 per-message 的字段保留原样,等宿主接线。
   *
   * ⚠️ 接线之前先看读者:`web/src/stores/chat.ts` 的 `currentUsage` 只累加
   * `input + output`(同一处的 `cacheRead` **没有读者**)—— 只把写侧接上,
   * 缓存命中的那部分仍然不会显示(契约 2026-10-05 扩它就是为了这个)。
   */
  emitMessageEnd(
    projectId: string | null,
    messageId: string,
    usage?: { input: number; output: number; cacheRead: number },
  ): void {
    this.broadcast({ type: "message_end", projectId, messageId, ...(usage !== undefined ? { usage } : {}) });
  }
  /**
   * **一个回合的用量刚落库** —— 实时把这一笔推给前端。
   *
   * ── 为什么事件里必须带 `projectId`(而不是让前端按当前上下文猜)──────
   *
   * 「按项目分组呈现」是这个界面的基本裁决:多项目并行时,一条不带 `projectId`
   * 的事件会被前端累积到**当前**那个项目上 —— A 项目烧的 token 记到 B 头上,
   * 而且两边都是合法数字,事后查不出来(bug② 那一类)。
   *
   * `projectId === null` 是**接待会话**(那笔账还没有项目,见 migration 018),
   * 不是「没有上下文」—— 契约里的 `ServerEvent` 对这个区分有整段说明。
   *
   * 载荷是**那一行**而不是新的合计:合计由 `GET /api/projects/:id/usage` 给权威值
   * (事件会丢,库不会)。与 `work_changed` / `blocker_changed` 同一条纪律。
   */
  emitUsageRecorded(row: TurnUsageRow): void {
    this.broadcast({
      type: "usage_recorded",
      projectId: row.projectId,
      usage: toTurnUsageView(this.deps.db, row),
    });
  }
  /**
   * 「某个工具开始跑了」。`tool_start` **自己也能建轮**
   * (`get().currentTurn ?? newTurn(e.messageId, ...)`)⇒ 同样必填 `agentId`。
   */
  emitToolStart(
    projectId: string | null,
    messageId: string,
    tool: WsToolInfo,
    agentId: string | null,
  ): void {
    this.broadcast({ type: "tool_start", projectId, messageId, agentId, tool });
  }
  emitToolEnd(projectId: string | null, messageId: string, tool: WsToolInfo): void {
    this.broadcast({ type: "tool_end", projectId, messageId, tool });
  }
  emitAgentEnd(projectId: string | null): void {
    this.broadcast({ type: "agent_end", projectId, ts: this.deps.now() });
  }

  /**
   * 业务经理刚在接待会话里立起了项目。
   *
   * **由 host 在回合结束后调用**,不由工具直接广播:工具在回合中间执行,
   * 那时候广播会让前端在一条正在流的回合里换上下文(半个回合的输出落错面板)。
   */
  emitProjectOpened(projectId: string, name: string): void {
    this.broadcast({ type: "project_opened", projectId, name });
  }

  // ⚠️ 这里**没有** `emitArtifactCreated`:它自批次 12 引入起就没有任何调用方
  // (工件变化目前只经 HTTP 回查到达前端),于 B3 死代码清理删除。
  // 与之配套的 `artifact_created` 契约成员 / 前端 handler 由各自的持有者处置。

  emitWorkChanged(projectId: string, workId: string, status: string): void {
    this.broadcast({ type: "work_changed", projectId, workId, status: status as never });
  }

  /** 把它转成 `client_question` 事件(工具落库之后由 channel.ask 触发)。 */
  emitClientQuestion(q: ClientQuestionView): void {
    this.broadcast({ type: "client_question", question: q });
  }

  // ── ClientChannel 实现 ────────────────────────────────────────

  /**
   * 真实的甲方通道。
   *
   * 它**不做落库** —— 提问工件由 `ask_client` 工具在调用本方法**之前**已经写好
   * (顺序反了会出现「问题已经发给用户但库里没有记录」,用户答完之后无处回填)。
   * 这里只负责把已有的那条工件广播出去。
   */
  get clientChannel(): ClientChannel {
    return {
      ask: async (input: ClientQuestion & { questionId: string; projectId: string }) => {
        const row = getArtifact(this.deps.db, input.questionId);
        if (row === null) {
          throw new Error(
            `channel.ask 收到的 questionId ${input.questionId} 在库里不存在 —— ` +
              `提问必须**先落库再投递**(见 ask_client 工具的注释)`,
          );
        }
        this.emitClientQuestion(toClientQuestionView(this.deps.db, row, (id) => nameOf(this.deps.db, id)));
      },

      tell: async ({ projectId, message, agentId }) => {
        // 播报也要落库:项目活过会话,只广播的话刷新就没了。
        // **作者是调用方给的真实 agent id** —— 从前这里写死成业务经理的 id,
        // 今天恰好对(只有它会播报),但组织表换 id 的那一刻就**静默归错人**。
        const at = this.deps.now();
        // **通道 = `client`(调用点显式声明)**:`tell_client` 就是「业务经理对
        // 甲方说话」,它属于**甲方通道**。交付对话开出来之后(C4),播报落在
        // 那场交付的对话里;开出来之前,`ensureSession` 明确回退到项目内部会话
        // (那条会话此刻就是甲方看得到的对话)—— 见 `ensureSession` 的注释。
        const sessionId = ensureSession(
          this.deps.db, projectId, at, this.deps.newId, "client",
        );
        appendSessionMessage(this.deps.db, {
          id: this.deps.newId("m"),
          sessionId,
          agentId,
          kind: "assistant",
          content: message,
          createdAt: at,
        });
        const messageId = this.deps.newId("msg");
        // **播报封套**(`source: "broadcast"`),不是回合封套 —— 它不带 `trigger`:
        // 播报与「这一轮为什么存在」正交,它无条件显示。见 `emitBroadcastStart`。
        this.emitBroadcastStart(projectId, messageId, "assistant", agentId);
        this.emitDelta(projectId, messageId, message);
        this.emitMessageEnd(projectId, messageId);
      },
    };
  }
}

// ── 辅助 ────────────────────────────────────────────────────────

function nameOf(db: Database.Database, agentId: string): string {
  const a = getAgent(db, agentId);
  return a !== null ? a.displayName : agentId;
}

/**
 * 「甲方说的话落进谁那条常驻会话」—— **面向甲方的那个角色**。
 *
 * 判据是代码内常量 `ROLE_SPECS[role].clientFacing`(今天只有业务经理为 true),
 * **不是写死的 `"bm"`**:`agents` 表里 id 是数据,`client.test.ts` 的夹具就是
 * `ag_business_manager` —— 写死的实现会静默问错人。
 *
 * 查不出来(组织还没播种)返回 `null`:调用方按「这个上下文里**任一角色**忙」
 * 处置(fail-closed —— 宁可多拒一条消息,不可让两条流打进同一条会话)。
 */
export function clientFacingAgentId(db: Database.Database): string | null {
  return listAgents(db).find((a) => ROLE_SPECS[a.role].clientFacing)?.id ?? null;
}

/**
 * 拿**这个通道**的那条会话,没有就建一条。**每个项目一条连续对话**(经校准的裁决)。
 *
 * `projectId === null` = **接待会话**:全局只有那一条(`project_id IS NULL`)。
 * 这里不额外做「只能有一条」的判定 —— 那条不变量在 **schema 层**由
 * `idx_session_single_intake` 机械保证(见 `migrations/012_intake_session.sql`),
 * 应用层再判一次只会多一处会漂的真相。
 *
 * ── ⚠️ `channel` 是**必填实参**,这就是 C4 拆的那条地雷 ─────────────
 *
 * 旧写法没有通道参数,于是只能 `listSessions(db, projectId)[0]` —— **挑项目里最新
 * 那条会话**。它今天恰好对(每项目一条),但交付会话(C4)一建出来,六处调用点就会
 * 把**所有角色**的消息都写进那条交付对话:消息一条不少,只是**分错了会话**,而
 * 表现是静默的(设计 1 §2.11.6)。现在每处调用点各自声明自己写的是内部通道还是
 * 甲方通道,库里的判据是 `(project_id, channel)`。
 *
 * **`client` 有一条明确回退(不是「挑最新的」)**:这条项目**还没有**交付对话时,
 * 落回项目内部会话。理由是可查的 —— 交付之前**不存在第二条对话**,那条内部会话
 * 就是甲方此刻能看到的对话。回退目标是唯一的(每个项目至多一条 `internal`),
 * 与旧写法那种「谁最新是谁」的含糊有本质区别。没有这条回退,任何一个 `client`
 * 调用点都会给项目**凭空造出**一条会话,于是「拆地雷不改行为」当场为假。
 *
 * ⚠️ 惰性建出来的会话**一律是 `internal`**:`client` 通道的会话只由平台在
 * `handover` 回合成功后开(`repo/sessions.ts` 的 `openDeliverableSession`)。
 * 让「甲方通道」可以由一次用户消息凭空产生,等于把「哪条对话是哪场交付开的」
 * 这个问题重新变成猜的。
 *
 * ⚠️ 接待会话**不校验项目存在**(没有项目可校验);项目会话必须校验 —— 往不存在的
 * 项目里写消息会让那条对话永远读不出来。
 */
export function ensureSession(
  db: Database.Database,
  projectId: string | null,
  at: number,
  newId: (p: string) => string,
  channel: SessionChannel,
): string {
  // 接待会话:通道对它没有意义(它既不是项目主会话,也不是交付对话)。
  // schema 的 `DEFAULT 'internal'` 就是它的通道。
  if (projectId === null) {
    const intake = listSessions(db, null);
    if (intake.length > 0) return intake[0]!.id;
    const id = newId("s");
    insertSession(db, { id, projectId: null, createdAt: at, channel: "internal" });
    return id;
  }
  if (getProjectRow(db, projectId) === null) {
    throw new Error(`项目 ${projectId} 不存在 —— 不能往不存在的项目里写消息`);
  }
  const picked =
    findSessionByChannel(db, projectId, channel) ??
    (channel === "client" ? findSessionByChannel(db, projectId, "internal") : null);
  if (picked !== null) return picked.id;
  const id = newId("s");
  insertSession(db, { id, projectId, createdAt: at, channel: "internal" });
  return id;
}

// ── 挂到 http.Server 上 ─────────────────────────────────────────

/** 只放行本机 Origin(与旧系统 B4 的处置一致;无 Origin 的客户端放行)。 */
function isAllowedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

export function attachHub(server: HttpServer, hub: PlatformHub): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const originRaw = req.headers.origin;
    const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
    if (typeof origin === "string" && !isAllowedOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => hub.addClient(ws));

  // 心跳:30 秒 ping 一次,没 pong 的判定为死连接
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, 30_000);
  timer.unref?.();

  return wss;
}
