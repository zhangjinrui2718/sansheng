/**
 * Sansheng · Executor · M3+ B3
 *
 * 角色:执行一个 `todo` artifact,产出 `evidence`(成功) / `hypothesis`(阻塞) / `note`(失败)。
 * 由 Orchestrator 在 todo 被 dispatch 时调用一次。
 *
 * 设计点:
 * - **DAG-aware**:执行前检查 dependsOn[] 全部 resolved;若有 unresolved → 标 todo `waiting_for_dependency`
 *   并等待 Orchestrator 在 `artifact_status_changed` 事件中唤醒
 * - **JSON-only 输出**:同 Planner;失败 → 写 note + mark todo failed
 * - **callback 触发**:写 hypothesis 后 emit `executor_callback` event,Orchestrator 端 watchdog + depth limit 接管
 * - **executorSessionId**:唯一标识一次执行,用于 callback 路由
 *
 * 不做的事:
 * - 不调 MessageBus —— Executor 只关心 BlackboardArtifact bus
 * - 不做并行 —— Executor 一次性跑完
 * - 不直接 call Communicator —— 通过 bus `executor_callback` 让 Orchestrator 路由
 */

import { nanoid } from "nanoid";
import type { BlackboardArtifact, ArtifactStatus, CallbackReason } from "../../../shared/types/blackboard.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import { log } from "../../shared/log.js";
import { parseJsonLenient } from "../../shared/jsonRepair.js";
import {
  upsertArtifact,
  updateArtifactStatus,
  getArtifact,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";
import { runWithTools, type LoopTool, type ToolLoopCall } from "./toolLoop.js";

/* ────────────────────────────────────────────────────────── *
 * 注入接口(测试可替换)
 * ────────────────────────────────────────────────────────── */

export interface ExecutorLlmCall {
  (input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

export interface ExecutorOptions {
  storage: Storage;
  bus?: typeof artifactBus;
  llmCall?: ExecutorLlmCall;
  systemPrompt?: string;
  now?: () => number;
  /**
   * A4(docs/CODE-REVIEW-2026-10-01.md §A4):resume 重跑时注入的用户/Communicator
   * decision(decision artifact 的 title+body)。用户回答全文在 body 里 —
   * 不注入时 LLM 只能在 siblings 上下文里看到一行标题(`[decision/open] User
   * decision for q-exec-x`),大概率重复产同一 hypothesis → 无界提问循环。
   */
  pendingDecision?: { title: string; body: string };
  /**
   * 批次 7-H:可用的完整工具列表(由 Orchestrator 组装:SDK sandbox 桥接 6 个 +
   * sansheng 原生 3 个)。
   * **不给 = 无工具**,保持 7-G 之前的行为。
   */
  tools?: LoopTool[];
  /**
   * 批次 7-H:本角色被授权的工具名(harness `tools/executor.json` 的 `allowed`)。
   *
   * 过滤刻意放在 **Executor 内部**而不是 Orchestrator:授权是安全边界,放在
   * 被授权方自己手里,任何调用方都无法因为疏忽而给超权限 —— 与 tools.ts 的
   * ceiling 分层同一思路(唯一裁决点)。不给 → 空名单 → 一律过滤掉。
   */
  allowedTools?: string[];
}

export type ExecutorOutcome =
  | { outcome: "evidence"; evidence: PlannedEvidence; nextStatus: "resolved" }
  | {
      outcome: "hypothesis";
      hypothesis: PlannedHypothesis;
      nextStatus: "waiting_for_decision";
    }
  | { outcome: "failed"; note: PlannedNote; nextStatus: "failed" };

export interface PlannedEvidence {
  title: string;
  body: string;
  metadata?: BlackboardArtifact["metadata"];
}

export interface PlannedHypothesis {
  title: string;
  body: string;
  callbackReason: CallbackReason;
  metadata?: BlackboardArtifact["metadata"];
}

export interface PlannedNote {
  title: string;
  body: string;
  metadata?: BlackboardArtifact["metadata"];
}

export interface ExecutorResult {
  todoId: string;
  executorSessionId: string;
  outcome: ExecutorOutcome["outcome"];
  artifactIds: string[]; // ids of artifacts produced (evidence/hypothesis/note)
}

/**
 * 截断标记:LLM 输出被 maxTokens 截断、经 repairTruncatedJson 救回时,
 * 在产物 metadata 上打 `truncated: true`。下游 synthesis 步骤与用户据此知道
 * 「这份内容写了一半」,而不是把残缺产物当完整结论用。
 */
function markTruncated(
  meta: unknown,
  truncated: boolean,
): BlackboardArtifact["metadata"] | undefined {
  const base = (meta as BlackboardArtifact["metadata"]) ?? undefined;
  if (!truncated) return base;
  return { ...(base ?? {}), truncated: true };
}

/**
 * 把被错位套进 `outcome` 里的 payload 信封解到顶层。
 *
 * 2026-10-03 真实事故(conv_murpu3ml_cged / todo-2,note `exec-err-7_P6zx5z`):
 * MiniMax-M3 交出
 * `{"outcome":{"evidence":{"title":"电话外呼抽象接口行业方案对比与推荐",…}}}`
 * —— `outcome` 是个**对象**而不是判别式字符串,evidence 完整躺在里面。旧代码里
 * `explicit !== undefined && explicit !== null && explicit !== ""` 把对象判成
 * 「非法取值」直接 return null,一份写完的调研报告被当 parse 失败丢掉 → todo
 * failed → 级联带走 todo-4。
 *
 * **同一个 bug 家族的第三次**:批次 7-D 救「缺省」(`{"evidence":{…}}`)、上一轮
 * 救「空串」(`{"outcome":"",…}`)、这次救「多包一层」。三者本质是同一种偏差 ——
 * 模型知道自己交的是 evidence,只是把外层包装的位置摆错了;用「解析不出来」
 * 惩罚它,等于因为信封没贴邮票就把信烧了。
 *
 * 只做**解包**,不新增任何猜测:内层认得出的 payload 键(evidence / hypothesis /
 * note)照常走既有形状推断;解包后仍认不出 → null,与既有「不凭空造产物」一致。
 * 同名键冲突时**外层优先** —— 外层是模型明确写下的,内层是错位嵌套进来的。
 *
 * `outcome` 是字符串 / 空串 / 数组 / null 时原样返回:那些是判别式的写法问题,
 * 归 `inferOutcome` 管,本函数不插手。
 */
function unwrapOutcomeEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  const inner = obj["outcome"];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return obj;
  return { ...(inner as Record<string, unknown>), ...obj, outcome: undefined };
}

/* ────────────────────────────────────────────────────────── *
 * Executor class
 * ────────────────────────────────────────────────────────── */

export class Executor {
  private readonly storage: Storage;
  private readonly bus: typeof artifactBus;
  private readonly llmCall: ExecutorLlmCall;
  private readonly systemPrompt: string;
  private readonly now: () => number;
  /** A4:resume 重跑时携带的用户/Communicator decision(首次执行为 undefined)。 */
  private readonly pendingDecision: { title: string; body: string } | undefined;
  /** 批次 7-H:按 allowedTools 过滤后的工具(构造时一次算好)。 */
  private readonly tools: LoopTool[];
  /** 批次 7-H:最近一次执行实际发生的工具调用(供 UI/日志/测试观察,不影响产物)。 */
  lastToolCalls: ToolLoopCall[] = [];
  /** 暴露给 Orchestrator 的 session id(由 ctor 时生成,稳定到本 Executor 生命周期)。 */
  readonly sessionId: string;
  private aborted = false;

  constructor(opts: ExecutorOptions) {
    this.storage = opts.storage;
    this.bus = opts.bus ?? artifactBus;
    this.llmCall = opts.llmCall ?? defaultExecutorLlmCall;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_EXECUTOR_PROMPT;
    this.now = opts.now ?? Date.now;
    this.pendingDecision = opts.pendingDecision;
    // 授权过滤在构造时完成:tools 是全集,allowedTools 是本角色的上界。
    // 两者任一缺失 → 空工具 → 走 7-G 之前的单轮路径。
    const allow = new Set(opts.allowedTools ?? []);
    this.tools = (opts.tools ?? []).filter((t) => allow.has(t.name));
    this.sessionId = `exec-${nanoid(10)}`;
  }

  /**
   * 主入口:接 todo → 产 outcome artifact(s) + 状态变更。
   *
   * 返回时,storage 已 upsert,bus 已 publish;Orchestrator 端只需订阅即可。
   * dependsOn 未满足时:标记 todo 为 `waiting_for_dependency`,return 即可(不产 artifact)。
   */
  async execute(todo: BlackboardArtifact): Promise<ExecutorResult> {
    if (this.aborted) {
      return { todoId: todo.id, executorSessionId: this.sessionId, outcome: "failed", artifactIds: [] };
    }
    if (todo.kind !== "todo") {
      throw new Error(`Executor.execute: expected kind='todo', got '${todo.kind}'`);
    }

    // 1. dependsOn 检查
    if (todo.dependsOn && todo.dependsOn.length > 0) {
      const unresolved = todo.dependsOn.filter((depId) => {
        const dep = getArtifact(this.storage.db, depId);
        return !dep || dep.status !== "resolved";
      });
      if (unresolved.length > 0) {
        // 阻塞:保持 todo.status='open',等 Orchestrator 在上游 artifact 状态变更时
        // 通过 tryUnblockDependents() 重新触发 spawnExecutorIfReady。不引入额外的
        // "waiting_for_dependency" 状态(超出 ArtifactStatus 语义),也避免让
        // onArtifactStatusChanged 把这个 todo 当作 failed 处理。
        return {
          todoId: todo.id,
          executorSessionId: this.sessionId,
          outcome: "failed", // 当前 run 中算 pending,不是真的失败
          artifactIds: [],
        };
      }
    }

    // 2. mark in_progress(让 UI 看到 Executor 正在干)
    updateArtifactStatus(this.storage.db, todo.id, "in_progress");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: "open",
      newStatus: "in_progress",
      actor: "executor",
    });

    // 3. 收集 context(siblings artifacts)
    const context = await this.gatherContext(todo);
    if (this.aborted) return this.abortedResult(todo);

    // 4. 调 LLM(批次 7-H:有工具时走工具循环;无工具时等价于原来的单轮)
    const userPrompt = this.buildUserPrompt(todo, context);
    let raw: string;
    try {
      const loop = await runWithTools({
        llmCall: this.llmCall,
        systemPrompt: this.systemPrompt,
        userPrompt,
        tools: this.tools,
      });
      this.lastToolCalls = loop.calls;
      if (loop.truncated) {
        // 轮数用尽仍不收敛 → 不拿半成品当结论(5b-1「残缺的产物不如没有」)
        await this.handleLlmFailure(
          todo,
          new Error(
            `executor: 工具调用 ${loop.toolTurns} 轮后仍未给出最终答案(上限内未收敛),已中止以免产出半成品`,
          ),
        );
        return { todoId: todo.id, executorSessionId: this.sessionId, outcome: "failed", artifactIds: [] };
      }
      raw = loop.finalText;
    } catch (err) {
      // C2(审查 §C2「abort 后 persist/事件发射加 aborted 守卫」):用户已经按停,
      // 迟到的失败不该再被翻译成 note + todo_failed 事件。
      if (this.aborted) return this.abortedResult(todo);
      // LLM 失败 → 写 failure note + mark todo failed
      await this.handleLlmFailure(todo, err);
      return {
        todoId: todo.id,
        executorSessionId: this.sessionId,
        outcome: "failed",
        artifactIds: [],
      };
    }

    // C2:llmCall 不可中断(ExecutorLlmCall 签名里没有 AbortSignal),所以 abort
    // 之后这个 await 仍会跑完。旧实现跑完就继续 parse + persist:落 evidence
    // artifact、publish artifact_created、把 todo 标成 resolved —— 用户明明按了
    // 停止,产物照样落库、UI 照样跳变。守卫点就落在 await 之后、任何副作用之前。
    if (this.aborted) return this.abortedResult(todo);

    // 5. Parse JSON
    const parsed = this.parseOutcome(raw);
    if (parsed === null) {
      if (this.aborted) return this.abortedResult(todo);
      await this.handleParseFailure(todo, raw);
      return {
        todoId: todo.id,
        executorSessionId: this.sessionId,
        outcome: "failed",
        artifactIds: [],
      };
    }

    // 6. 落 artifact + 更新 todo status
    if (this.aborted) return this.abortedResult(todo);
    return await this.persistOutcome(todo, parsed);
  }

  /**
   * 批次 4b C2(审查 §C2「Executor.abort 只设 flag」):
   * 设置中断标志。注意它**不**取消在飞的 llmCall —— ExecutorLlmCall 签名里没有
   * AbortSignal,加一个要改所有注入方(kernel 的 makeLlmCall / 各测试 fake),
   * 且 pi-ai 的 completeSimple 只在整轮结束时才检查中断。真正生效的是
   * execute() 内在 await 之后、任何副作用之前的那几道 aborted 守卫。
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * C2:abort 后的统一返回。**不落库、不发事件、不改 todo 终态** ——
   * todo 停在 in_progress 是刻意的:谁来收它由 Orchestrator 决定
   * (abort → dispose 清 activeExecutors;run 以 "Orchestrator aborted" 收尾,
   *  lib 层不再往下推进;若进程重启则由 B8 boot 对账兜底)。
   */
  private abortedResult(todo: BlackboardArtifact): ExecutorResult {
    log.warn(`executor: aborted mid-flight, discarding outcome for todo ${todo.id}`);
    return {
      todoId: todo.id,
      executorSessionId: this.sessionId,
      outcome: "failed",
      artifactIds: [],
    };
  }

  /* ── private helpers ────────────────────────────────────── */

  private async gatherContext(todo: BlackboardArtifact): Promise<BlackboardArtifact[]> {
    const { listArtifacts } = await import("../storage/index.js");
    if (!todo.conversationId) return [];
    return listArtifacts(this.storage.db, {
      scope: "conversation",
      conversationId: todo.conversationId,
      limit: 50,
    });
  }

  private buildUserPrompt(todo: BlackboardArtifact, siblings: BlackboardArtifact[]): string {
    const parts: string[] = [];
    parts.push(`# Todo`);
    parts.push(`id: ${todo.id}`);
    parts.push(`title: ${todo.title}`);
    parts.push(`body: ${todo.body}`);
    if (todo.parentIntent) parts.push(`parentIntent: ${todo.parentIntent}`);
    if (todo.dependsOn && todo.dependsOn.length > 0) {
      parts.push(`dependsOn (all resolved): ${todo.dependsOn.join(", ")}`);
    }
    // A4(docs/CODE-REVIEW-2026-10-01.md §A4):resume 重跑时逐字注入用户/Communicator
    // 的 decision(回答全文在 decision.body)。放在 siblings 之前 — 这是本次重跑
    // 最关键的上下文;不注入时 LLM 只能在 siblings 里看到一行 decision 标题。
    if (this.pendingDecision) {
      parts.push("");
      parts.push(`# Decision(来自用户/Communicator)`);
      parts.push(`title: ${this.pendingDecision.title}`);
      parts.push(this.pendingDecision.body);
    }
    if (siblings.length > 0) {
      parts.push("");
      parts.push(`# Sibling Blackboard Artifacts (${siblings.length})`);
      for (const a of siblings) {
        const prefix = a.id === todo.id ? "→ " : "  ";
        parts.push(`${prefix}[${a.kind}/${a.status}] ${a.title} (id=${a.id})`);
      }
    }
    parts.push("");
    parts.push(`# Task`);
    parts.push(
      `Produce JSON describing the outcome. Output JSON only, no markdown fence.`,
    );
    return parts.join("\n");
  }

  private parseOutcome(raw: string): ExecutorOutcome | null {
    const parsedRaw = parseJsonLenient<Record<string, unknown>>(raw);
    if (!parsedRaw.ok) return null;
    if (parsedRaw.repaired) {
      // 输出被 maxTokens 截断(2026-10-02 真实事故:conv_muqsidb0_wgru/todo-2,
      // 撞上限后半截 JSON 曾被当成成功 → todo failed → cascade 带走 3 个下游)。
      // 现在救回已写出的部分,但必须留痕 —— 产物是「不完整」而非「完整」。
      log.warn(
        `executor: LLM output was truncated mid-JSON, salvaged partial outcome (raw ${raw.length} chars)`,
      );
    }
    const rawObj = parsedRaw.value;
    if (!rawObj || typeof rawObj !== "object") return null;
    const truncated = parsedRaw.repaired;

    // 2026-10-03 事故(conv_murpu3ml_cged / todo-2,note `exec-err-7_P6zx5z`):
    // 模型把 payload **错位套进了 `outcome` 对象**(`{"outcome":{"evidence":{…}}}`),
    // 而不是写判别式字符串。解包后 `evidence` 才回到顶层,下面的形状推断与
    // payload 取值才看得见它。留痕以便发现提示词漂移 —— 详见 unwrapOutcomeEnvelope。
    const obj = unwrapOutcomeEnvelope(rawObj);
    if (obj !== rawObj) {
      log.warn(
        `executor: outcome 键是个对象而非判别式,已解包内层 payload (raw ${raw.length} chars)`,
      );
    }

    // 批次 7-D:`outcome` 判别式**可缺省**,由 payload 形状反推。
    //
    // 真实事故(conv_muqsidb0_wgru 第二次跑,todo-1,note `exec-err-e2hIDyhy`):
    // 模型输出 `{"evidence":{"title":"百万级外呼…","body":"## 结论先行…}}` ——
    // JSON 合法、title 完整、正文写得很充实,**唯独没写 `outcome` 字段**。
    // 旧实现只认 `obj.outcome === "evidence"`,于是把一份完全可用的 evidence
    // 当成 parse 失败丢掉 → todo failed → 级联带走其余 5 个 todo。
    //
    // 为什么会漏:模型「知道」自己交的是 evidence,就把外层包装省了。这是
    // LLM 最常见也最无害的 schema 偏差 —— 用「解析不出来」惩罚它,等于
    // 因为信封没贴邮票就把信烧了。`outcome` 只在**与 payload 形状矛盾**时
    // 才作为覆盖(例如 `{"outcome":"failed","note":{...}}` 明确说失败)。
    const outcome = this.inferOutcome(obj);

    if (outcome === "evidence") {
      const ev = obj.evidence as Record<string, unknown> | undefined;
      if (!ev || typeof ev.title !== "string") return null;
      return {
        outcome: "evidence",
        nextStatus: "resolved",
        evidence: {
          title: ev.title.slice(0, 200),
          body: typeof ev.body === "string" ? ev.body : "",
          // truncated=true 时 body 是「写到一半」的部分内容 —— 显式留痕,
          // 让下游 synthesis 步骤和用户都知道这份 evidence 不完整。
          metadata: markTruncated(ev.metadata, truncated),
        },
      };
    }

    if (outcome === "hypothesis") {
      const hyp = obj.hypothesis as Record<string, unknown> | undefined;
      if (!hyp || typeof hyp.title !== "string") return null;
      const reason = hyp.callbackReason === "harness_proposal" ? "harness_proposal" : "judgment";
      const meta = (hyp.metadata as BlackboardArtifact["metadata"]) ?? {};
      return {
        outcome: "hypothesis",
        nextStatus: "waiting_for_decision",
        hypothesis: {
          title: hyp.title.slice(0, 200),
          body: typeof hyp.body === "string" ? hyp.body : "",
          callbackReason: reason,
          metadata: { ...markTruncated(meta, truncated), callbackReason: reason },
        },
      };
    }

    if (outcome === "failed") {
      const note = obj.note as Record<string, unknown> | undefined;
      if (!note || typeof note.title !== "string") return null;
      return {
        outcome: "failed",
        nextStatus: "failed",
        note: {
          title: note.title.slice(0, 200),
          body: typeof note.body === "string" ? note.body : "",
          metadata: markTruncated(note.metadata, truncated),
        },
      };
    }
    return null;
  }

  /**
   * 判定 outcome:显式 `outcome` 优先,缺省时按 payload 键反推。
   *
   * - `{"evidence":{...}}`  → evidence(批次 7-D,真实事故 `exec-err-e2hIDyhy`)
   * - `{"hypothesis":{...}}`→ hypothesis
   * - `{"note":{...}}`     → failed(note 是失败时才产出的东西)
   * - 显式 `outcome` 与形状矛盾时**以显式值为准**(模型明确说了 failed 就别硬救)。
   * - 什么都没有 → null(交由调用方走 parse 失败路径)。
   */
  private inferOutcome(obj: Record<string, unknown>): ExecutorOutcome["outcome"] | null {
    const explicit = obj.outcome;
    if (explicit === "evidence" || explicit === "hypothesis" || explicit === "failed") {
      return explicit;
    }
    // 空字符串 = 模型声明了这个键但没填值,语义上**等同没写**,继续走形状推断。
    //
    // 2026-10-02 真实事故(conv_muqwgghs_4q0u / todo-5,note `exec-err-boBJpM8r`):
    // MiniMax-M3 交出 `{"outcome":"","status":"in_progress","evidence":{...}}` ——
    // evidence 完整(title + 长正文都在),但 outcome 留了空串。下面这条「非法取值 →
    // 不猜」的规则把空串判成非法,直接 return null,批次 7-D 辛苦加的形状推断
    // **根本没机会跑**。实测同一份 payload 删掉 outcome 字段就能正常救回。
    // 真正该拒绝的是 `outcome:"gossip"` 这种**携带错误信息**的取值;`""` 不携带
    // 任何信息,拿它否决一份完好的产物,等于因为信封没贴邮票就把信烧了。
    if (explicit !== undefined && explicit !== null && explicit !== "") {
      return null;
    }
    if (obj.evidence && typeof obj.evidence === "object") return "evidence";
    if (obj.hypothesis && typeof obj.hypothesis === "object") return "hypothesis";
    if (obj.note && typeof obj.note === "object") return "failed";
    return null;
  }

  private async persistOutcome(
    todo: BlackboardArtifact,
    parsed: ExecutorOutcome,
  ): Promise<ExecutorResult> {
    const ts = this.now();
    const artifactIds: string[] = [];

    if (parsed.outcome === "evidence") {
      const evidenceId = `ev-${nanoid(10)}`;
      const evidence = makeArtifact({
        id: evidenceId,
        scope: todo.scope,
        conversationId: todo.conversationId,
        kind: "evidence",
        title: parsed.evidence.title,
        body: parsed.evidence.body,
        author: "executor",
        status: "resolved",
        parentIntent: todo.parentIntent,
        metadata: {
          relatedArtifacts: [todo.id, ...((parsed.evidence.metadata?.relatedArtifacts as string[] | undefined) ?? [])],
          ...parsed.evidence.metadata,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, evidence);
      this.bus.publish({ type: "artifact_created", artifact: evidence });
      artifactIds.push(evidenceId);
      updateArtifactStatus(this.storage.db, todo.id, "resolved");
      this.bus.publish({
        type: "artifact_status_changed",
        artifactId: todo.id,
        oldStatus: "in_progress",
        newStatus: "resolved",
        actor: "executor",
      });
    } else if (parsed.outcome === "hypothesis") {
      const hypothesisId = `hyp-${nanoid(10)}`;
      const hypothesis = makeArtifact({
        id: hypothesisId,
        scope: todo.scope,
        conversationId: todo.conversationId,
        kind: "hypothesis",
        title: parsed.hypothesis.title,
        body: parsed.hypothesis.body,
        author: "executor",
        status: "open",
        parentIntent: todo.parentIntent,
        metadata: {
          relatedArtifacts: [todo.id],
          callbackReason: parsed.hypothesis.callbackReason,
          ...parsed.hypothesis.metadata,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, hypothesis);
      this.bus.publish({ type: "artifact_created", artifact: hypothesis });
      artifactIds.push(hypothesisId);

      // mark todo as waiting_for_decision(用户 / Communicator 决策时再 resume)
      updateArtifactStatus(this.storage.db, todo.id, "waiting_for_decision");
      this.bus.publish({
        type: "artifact_status_changed",
        artifactId: todo.id,
        oldStatus: "in_progress",
        newStatus: "waiting_for_decision",
        actor: "executor",
      });

      // emit executor_callback event — Orchestrator 端路由到 Communicator
      this.bus.publish({
        type: "executor_callback",
        executorSessionId: this.sessionId,
        hypothesisId,
        reason: parsed.hypothesis.callbackReason,
      });
    } else {
      // failed
      const noteId = `exec-err-${nanoid(8)}`;
      const note = makeArtifact({
        id: noteId,
        scope: todo.scope,
        conversationId: todo.conversationId,
        kind: "note",
        title: parsed.note.title,
        body: parsed.note.body,
        author: "executor",
        status: "resolved",
        parentIntent: todo.parentIntent,
        metadata: {
          relatedArtifacts: [todo.id],
          ...parsed.note.metadata,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, note);
      this.bus.publish({ type: "artifact_created", artifact: note });
      artifactIds.push(noteId);

      // todo status 已在 parsed.nextStatus = "failed",显式 publish status change
      updateArtifactStatus(this.storage.db, todo.id, "failed");
      this.bus.publish({
        type: "artifact_status_changed",
        artifactId: todo.id,
        oldStatus: "in_progress",
        newStatus: "failed",
        actor: "executor",
      });
    }

    return {
      todoId: todo.id,
      executorSessionId: this.sessionId,
      outcome: parsed.outcome,
      artifactIds,
    };
  }

  private async handleParseFailure(todo: BlackboardArtifact, raw: string): Promise<void> {
    const ts = this.now();
    const noteId = `exec-err-${nanoid(8)}`;
    const note = makeArtifact({
      id: noteId,
      scope: todo.scope,
      conversationId: todo.conversationId,
      kind: "note",
      title: `Executor · parse failed for ${todo.id.slice(0, 8)}`,
      body: `Executor LLM output not valid JSON outcome.\n\nRaw (first 500 chars):\n${raw.slice(0, 500)}`,
      author: "executor",
      status: "resolved",
      parentIntent: todo.parentIntent,
      metadata: { relatedArtifacts: [todo.id] },
      createdAt: ts,
      updatedAt: ts,
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    updateArtifactStatus(this.storage.db, todo.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: "in_progress",
      newStatus: "failed",
      actor: "executor",
    });
  }

  private async handleLlmFailure(todo: BlackboardArtifact, err: unknown): Promise<void> {
    const ts = this.now();
    const msg = err instanceof Error ? err.message : String(err);
    const noteId = `exec-err-${nanoid(8)}`;
    const note = makeArtifact({
      id: noteId,
      scope: todo.scope,
      conversationId: todo.conversationId,
      kind: "note",
      title: `Executor · LLM failed for ${todo.id.slice(0, 8)}`,
      body: `LLM call threw: ${msg}`,
      author: "executor",
      status: "resolved",
      parentIntent: todo.parentIntent,
      metadata: { relatedArtifacts: [todo.id] },
      createdAt: ts,
      updatedAt: ts,
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    updateArtifactStatus(this.storage.db, todo.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: "in_progress",
      newStatus: "failed",
      actor: "executor",
    });
  }
}

/* ────────────────────────────────────────────────────────── *
 * Default LLM call + prompt
 * ────────────────────────────────────────────────────────── */

const defaultExecutorLlmCall: ExecutorLlmCall = async () => {
  throw new Error(
    "Executor.llmCall not injected. Orchestrator boot must provide a real LLM call.",
  );
};

export const DEFAULT_EXECUTOR_PROMPT = `# Sansheng · Executor

执行一个 todo,产 outcome JSON:
- outcome=evidence → {evidence:{title,body,metadata?}, nextStatus:"resolved"}
- outcome=hypothesis → {hypothesis:{title,body,callbackReason,metadata?}, nextStatus:"waiting_for_decision"}
- outcome=failed → {note:{title,body}, nextStatus:"failed"}

不要解释,不要 markdown fence。
`;

/* ────────────────────────────────────────────────────────── *
 * Re-exports
 * ────────────────────────────────────────────────────────── */

export type { BlackboardArtifact, ArtifactStatus };
