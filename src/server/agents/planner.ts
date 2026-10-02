/**
 * Sansheng · Planner · M3+ B3
 *
 * 角色:把一个 `intent` artifact 拆成一组 `todo` artifacts(DAG,带 dependsOn)。
 * 由 Orchestrator 在 `artifact_created kind='intent' status='open'` 时调用一次。
 *
 * 设计点:
 * - **依赖注入**:llmCall / bus / storage 都可被测试替换
 * - **JSON-only 输出**:严格 parse + 验证,失败 → 写 note + mark intent failed
 * - **DAG-aware**:dependsOn[] 引用其他 todo id;Orchestrator 端按依赖顺序 spawn Executor
 * - **同步落地**:所有 todo 在 Planner 内部一次性 upsert + publish,
 *   让 Executor 端可以立刻看到 dependsOn 集合
 *
 * 不做的事:
 * - 不产 `evidence` / `hypothesis` —— 那是 Executor 的活
 * - 不接 MessageBus —— Planner 只关心 BlackboardArtifact
 * - 不做并行调度 —— Planner 一次性把整个 plan 写完
 */

import { nanoid } from "nanoid";
import type { BlackboardArtifact, ArtifactStatus } from "../../../shared/types/blackboard.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import { log } from "../../shared/log.js";
import {
  upsertArtifact,
  updateArtifactStatus,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";

/* ────────────────────────────────────────────────────────── *
 * DAG cycle detection helper
 * 给定已 validate 且 dependsOn 全为已知 id 的 todos，找出依赖图中的环节点并 drop。
 * 警告推入 warnings[]（“dropped todo X due to cycle: ...”）。
 * 实现：DFS 三色标记（white/gray/black）。输出不含环上节点，但保留环外合法节点。
 * ────────────────────────────────────────────────────────── */

function dropCycles(
  todos: PlannedTodo[],
  warnings: string[],
): PlannedTodo[] {
  const idToTodo = new Map<string, PlannedTodo>();
  for (const t of todos) idToTodo.set(t.id, t);

  const color = new Map<string, "white" | "gray" | "black">(); // 0=未访,1=栈中,2=完成
  const cycleMembers = new Set<string>();
  const stackPath: string[] = [];

  function visit(id: string): void {
    const c = color.get(id);
    if (c === "black") return;
    if (c === "gray") {
      // 环：从栈中 id 到当前 id 的所有节点都是环成员。
      const idx = stackPath.indexOf(id);
      if (idx >= 0) {
        for (let i = idx; i < stackPath.length; i++) {
          cycleMembers.add(stackPath[i]!);
        }
        cycleMembers.add(id);
      }
      return;
    }
    color.set(id, "gray");
    stackPath.push(id);
    const todo = idToTodo.get(id);
    if (todo) {
      for (const dep of todo.dependsOn) {
        if (idToTodo.has(dep)) visit(dep);
      }
    }
    stackPath.pop();
    color.set(id, "black");
  }

  for (const t of todos) visit(t.id);

  if (cycleMembers.size === 0) return todos;

  for (const id of cycleMembers) {
    const t = idToTodo.get(id);
    warnings.push(
      `dropped todo ${id} due to cycle: ${
        t ? t.dependsOn.join(",") : "(missing)"
      }`,
    );
  }
  return todos.filter((t) => !cycleMembers.has(t.id));
}

/**
 * 批次 4b C3:抽取「unknown dependsOn 过滤」为独立函数,并让它**迭代到不动点**。
 *
 * 循环上限的论证(为什么不会死循环):每一轮要么至少 drop 一个 todo(集合严格变小,
 * 最多 todos.length 轮必然空),要么一轮内一个都没 drop(直接 break)。两条路都收敛,
 * 上限只是纵深防御 —— 真正的收益是「调用点可以在中间插入任意 drop 步骤
 * (dropCycles)之后再回来重跑」。
 */
const MAX_DEP_FILTER_ROUNDS = 8;

function dropUnknownDeps(
  todos: PlannedTodo[],
  warnings: string[],
  reason: string,
): PlannedTodo[] {
  let survivors = todos;
  for (let round = 0; round < MAX_DEP_FILTER_ROUNDS; round++) {
    const known = new Set(survivors.map((t) => t.id));
    const next: PlannedTodo[] = [];
    for (const t of survivors) {
      const badDeps = t.dependsOn.filter((d) => !known.has(d));
      if (badDeps.length > 0) {
        warnings.push(`dropped todo ${t.id} due to ${reason}: ${badDeps.join(",")}`);
        continue;
      }
      next.push(t);
    }
    if (next.length === survivors.length) return next; // 不动点
    survivors = next;
  }
  // 上限触发:理论上不可达(见函数注释),留一条日志线索而不是静默返回。
  warnings.push(
    `planner: unknown-dep filter hit the ${MAX_DEP_FILTER_ROUNDS}-round cap; ${survivors.length} todo(s) kept`,
  );
  return survivors;
}

/* ────────────────────────────────────────────────────────── *
 * 注入接口(测试可替换)
 * ────────────────────────────────────────────────────────── */

export interface PlannerLlmCall {
  /** 给定 system + user prompt → 返回 raw 模型输出(text,可能含 ```json``` fence)。 */
  (input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

export interface PlannerOptions {
  storage: Storage;
  /** 可选:注入 artifactBus(测试用,默认走全局单例) */
  bus?: typeof artifactBus;
  /** 可选:注入 llm 调用,默认抛错(必须由 Orchestrator boot 时提供) */
  llmCall?: PlannerLlmCall;
  /** Planner system prompt(默认从文件读 shared/prompts/planner.md)。 */
  systemPrompt?: string;
  /** 现在时间(测试用)。 */
  now?: () => number;
}

export interface PlannedTodo {
  id: string;
  title: string;
  body: string;
  dependsOn: string[];
  metadata?: BlackboardArtifact["metadata"];
}

export interface PlannerResult {
  intent: BlackboardArtifact;
  todos: BlackboardArtifact[];
}

/* ────────────────────────────────────────────────────────── *
 * Planner class
 * ────────────────────────────────────────────────────────── */

export class Planner {
  private readonly storage: Storage;
  private readonly bus: typeof artifactBus;
  private readonly llmCall: PlannerLlmCall;
  private readonly systemPrompt: string;
  private readonly now: () => number;

  constructor(opts: PlannerOptions) {
    this.storage = opts.storage;
    this.bus = opts.bus ?? artifactBus;
    this.llmCall = opts.llmCall ?? defaultPlannerLlmCall;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_PLANNER_PROMPT;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 主入口:接 intent → 产 todos。
   * 同步语义:调用返回时,所有 todo 已写入 storage + bus 已 publish。
   * Orchestrator 端只需要订阅 bus `artifact_created` 就能接力。
   */
  async plan(intent: BlackboardArtifact): Promise<PlannerResult> {
    if (intent.kind !== "intent") {
      throw new Error(`Planner.plan: expected kind='intent', got '${intent.kind}'`);
    }

    // 1. 收集 current blackboard context(siblings intent 看不到,但同 conv 已存在的 todos 可以看)
    const siblings = await this.gatherContext(intent);

    // 2. 调 LLM(失败 → 写 failure note + mark intent failed,与 Executor 对称)
    const userPrompt = this.buildUserPrompt(intent, siblings);
    let raw: string;
    try {
      raw = await this.llmCall({
        systemPrompt: this.systemPrompt,
        userPrompt,
      });
    } catch (err) {
      await this.handleLlmFailure(intent, err);
      return { intent, todos: [] };
    }

    // 3. Parse JSON 数组
    const planned = this.parseTodoArray(raw);
    if (planned === null) {
      // JSON parse / validate 失败 → 写 failure note + mark intent failed
      await this.handleParseFailure(intent, raw);
      return { intent, todos: [] };
    }

    // 4. 校验 + 规范化
    const validated = this.validateAndNormalize(planned);
    // C3(审查 §C3「warnings 算完即丢,静默发生」):留痕。drop 是**有损**操作
    // (LLM 少产了 todo / 依赖写错 / 成环),用户看到的却是「计划里本来就没这几条」,
    // 无从判断是模型还是管线出的问题。每条 warning 一行 log.warn,便于事后
    // 对照 timeline / blackboard 复盘。
    for (const w of validated.warnings) {
      log.warn(`planner: ${w}`);
    }
    if (validated.todos.length === 0) {
      await this.handleParseFailure(intent, raw, "0 valid todos after validation");
      return { intent, todos: [] };
    }

    // 5. 写 todos 到 storage + publish bus
    const persisted: BlackboardArtifact[] = [];
    const ts = this.now();
    for (const t of validated.todos) {
      const artifact: BlackboardArtifact = makeArtifact({
        id: t.id,
        scope: intent.scope ?? "global",
        conversationId: intent.conversationId,
        kind: "todo",
        title: t.title,
        body: t.body,
        author: "planner",
        status: "open" as ArtifactStatus,
        dependsOn: t.dependsOn,
        parentIntent: intent.id,
        executors: ["executor"], // D8 execution tracking:声明可执行该 todo 的 executor(s)
        metadata: t.metadata,
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, artifact);
      this.bus.publish({ type: "artifact_created", artifact });
      persisted.push(artifact);
    }

    return { intent, todos: persisted };
  }

  /* ── private helpers ────────────────────────────────────── */

  private async gatherContext(intent: BlackboardArtifact): Promise<BlackboardArtifact[]> {
    // 简化:同 conversationId 已存在的 artifacts(实际可能需要 global)
    // 存储层 listArtifacts 是同步 API,这里 await 是为了未来加 async IO
    const { listArtifacts } = await import("../storage/index.js");
    if (!intent.conversationId) return [];
    return listArtifacts(this.storage.db, {
      scope: "conversation",
      conversationId: intent.conversationId,
      limit: 50,
    });
  }

  private buildUserPrompt(intent: BlackboardArtifact, siblings: BlackboardArtifact[]): string {
    const parts: string[] = [];
    parts.push(`# Intent`);
    parts.push(`id: ${intent.id}`);
    parts.push(`title: ${intent.title}`);
    parts.push(`body: ${intent.body}`);
    if (intent.metadata) {
      parts.push(`metadata: ${JSON.stringify(intent.metadata)}`);
    }
    if (siblings.length > 0) {
      parts.push("");
      parts.push(`# Existing Blackboard Artifacts (${siblings.length})`);
      for (const a of siblings) {
        parts.push(`- [${a.kind}/${a.status}] ${a.title} (id=${a.id})`);
      }
    }
    parts.push("");
    parts.push(`# Task`);
    parts.push(`Produce a JSON array of todos for this intent. Output JSON only.`);
    return parts.join("\n");
  }

  private parseTodoArray(raw: string): PlannedTodo[] | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let jsonText = trimmed;
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) {
      jsonText = fence[1].trim();
    } else {
      const brace = jsonText.indexOf("[");
      if (brace >= 0) jsonText = jsonText.slice(brace);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    return parsed as PlannedTodo[];
  }

  private validateAndNormalize(
    planned: PlannedTodo[],
  ): { todos: PlannedTodo[]; warnings: string[] } {
    const warnings: string[] = [];
    const seen = new Set<string>();
    const todos: PlannedTodo[] = [];
    for (let i = 0; i < planned.length; i++) {
      const t = planned[i];
      if (!t || typeof t !== "object") continue;
      if (typeof t.title !== "string" || !t.title.trim()) continue;
      if (typeof t.body !== "string") t.body = "";

      // ID:use provided or generate;ensure unique (first wins on duplicate)
      const id = typeof t.id === "string" && t.id.trim() ? t.id : `todo-${nanoid(8)}`;
      if (seen.has(id)) continue; // dedup: first occurrence wins, later dropped
      seen.add(id);

      const dependsOn = Array.isArray(t.dependsOn)
        ? t.dependsOn.filter((d) => typeof d === "string")
        : [];

      todos.push({
        id,
        title: t.title.trim().slice(0, 200),
        body: t.body,
        dependsOn,
        metadata: t.metadata && typeof t.metadata === "object" ? t.metadata : undefined,
      });
    }
    // 校验(第一轮):dependsOn 引用的 id 必须在 todos 数组内;含任何未知 id → 整个 todo drop
    let survivors = dropUnknownDeps(todos, warnings, "unknown dependsOn");
    // 校验:DAG 环检测(LLM 可能输出 A→B,B→A 这种自反 / 互反依赖)。
    // 环上节点全部 drop(Orchestrator 永远 resolve 不了,会无限等待)。
    survivors = dropCycles(survivors, warnings);
    // C3(审查 §C3「dropCycles 不级联」):环 drop 之后**必须重跑** unknown-dep 过滤。
    // 旧顺序是「过滤 → dropCycles」一次到底,于是环上节点被 drop 后,依赖它们的
    // 存活 todo 的 dependsOn 指向了不存在的 id —— Orchestrator 的 areDepsResolved
    // 永远 false → 该 todo 永不 spawn,run 只能等满 maxRunMs 超时(叠加 §A3 放大)。
    // 例:A→B,B↔C 成环 ⇒ drop B、C 之后 A 成为悬空依赖,必须连 A 一起 drop。
    // 两轮已足够收敛:第一轮 drop 掉的节点不会引入新悬空;第二轮之后剩余集合
    // 内部的依赖图已经没有环(dropCycles 已清),每条边都指向集合内的存活节点。
    // 再多轮只是重复同一批断言 —— 仍保留循环上限(见 dropUnknownDeps),万一将来
    // 校验规则增加,也不会退化成死循环。
    survivors = dropUnknownDeps(survivors, warnings, "unknown dependsOn (after cycle drop)");
    return { todos: survivors, warnings };
  }

  private async handleParseFailure(
    intent: BlackboardArtifact,
    raw: string,
    extra?: string,
  ): Promise<void> {
    const ts = this.now();
    const noteId = `planner-err-${nanoid(8)}`;
    const note = makeArtifact({
      id: noteId,
      scope: intent.scope ?? "global",
      conversationId: intent.conversationId,
      kind: "note",
      title: `Planner · parse failed for ${intent.id.slice(0, 8)}`,
      body: `Planner LLM output not valid JSON todos array.${extra ? " " + extra : ""}\n\nRaw (first 500 chars):\n${raw.slice(0, 500)}`,
      author: "planner",
      status: "resolved",
      parentIntent: intent.id,
      metadata: { relatedArtifacts: [intent.id] },
      createdAt: ts,
      updatedAt: ts,
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    // mark intent failed
    updateArtifactStatus(this.storage.db, intent.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: intent.id,
      oldStatus: "open",
      newStatus: "failed",
      actor: "planner",
    });
  }

  private async handleLlmFailure(
    intent: BlackboardArtifact,
    err: unknown,
  ): Promise<void> {
    const ts = this.now();
    const msg = err instanceof Error ? err.message : String(err);
    const noteId = `planner-err-${nanoid(8)}`;
    const note = makeArtifact({
      id: noteId,
      scope: intent.scope ?? "global",
      conversationId: intent.conversationId,
      kind: "note",
      title: `Planner · LLM failed for ${intent.id.slice(0, 8)}`,
      body: `LLM call threw: ${msg}`,
      author: "planner",
      status: "resolved",
      parentIntent: intent.id,
      metadata: { relatedArtifacts: [intent.id] },
      createdAt: ts,
      updatedAt: ts,
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    // mark intent failed(对称 Executor.handleLlmFailure)
    updateArtifactStatus(this.storage.db, intent.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: intent.id,
      oldStatus: "open",
      newStatus: "failed",
      actor: "planner",
    });
  }
}

/* ────────────────────────────────────────────────────────── *
 * Default LLM call(boot 时 Orchestrator 注入真 llm)
 * ────────────────────────────────────────────────────────── */

const defaultPlannerLlmCall: PlannerLlmCall = async () => {
  throw new Error(
    "Planner.llmCall not injected. Orchestrator boot must provide a real LLM call.",
  );
};

/* ────────────────────────────────────────────────────────── *
 * Default prompt(fallback — 实际由 boot 从 .md 读)
 * ────────────────────────────────────────────────────────── */

export const DEFAULT_PLANNER_PROMPT = `# Sansheng · Planner

你是 Planner。把一个 intent 拆成 todos (DAG with dependsOn)。

输出:strict JSON array,每个元素 {id, title, body, dependsOn, metadata?}

不要解释,不要 markdown fence。
`;
