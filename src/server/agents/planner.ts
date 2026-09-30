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
import {
  upsertArtifact,
  updateArtifactStatus,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";

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

    // 2. 调 LLM
    const userPrompt = this.buildUserPrompt(intent, siblings);
    const raw = await this.llmCall({
      systemPrompt: this.systemPrompt,
      userPrompt,
    });

    // 3. Parse JSON 数组
    const planned = this.parseTodoArray(raw);
    if (planned === null) {
      // JSON parse / validate 失败 → 写 failure note + mark intent failed
      await this.handleParseFailure(intent, raw);
      return { intent, todos: [] };
    }

    // 4. 校验 + 规范化
    const validated = this.validateAndNormalize(planned);
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
    // 校验:dependsOn 引用的 id 必须在 todos 数组内;含任何未知 id → 整个 todo drop
    const allIds = new Set(todos.map((t) => t.id));
    const filtered: PlannedTodo[] = [];
    for (const t of todos) {
      const badDeps = t.dependsOn.filter((d) => !allIds.has(d));
      if (badDeps.length > 0) {
        warnings.push(`dropped todo ${t.id} due to unknown dependsOn: ${badDeps.join(",")}`);
        continue;
      }
      filtered.push(t);
    }
    return { todos: filtered, warnings };
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
