/**
 * Sansheng Orchestrator · M3b
 *
 * 多 agent 主循环:
 *   1. memory    : retrieve related fragments + profile (本地查)
 *   2. planner   : 根据 goal + blackboard 现状产出 plan
 *   3. executors : 每个 executor 负责不同 plan step,并行
 *   4. critic    : 评估 evidence 是否覆盖 plan,产出 CritiqueRound
 *   5. 若未 approve 且 iter < budget,回到 2;否则 abandon
 *   6. reflection: run 结束后追加 fragment
 *   7. 落库 + 返回
 *
 * 设计点:
 * - 每轮通过 sink(p) 推送 progress,ws 层把它转成 blackboard_update 事件。
 * - runnerFactory 可注入 → 单元测试用 FakeAgentRunner,不依赖真实 LLM。
 */
import { nanoid } from "nanoid";
import {
  upsertBlackboard,
} from "../storage/repo/blackboards.js";
import {
  searchFragmentsByText,
  listProfile,
  insertFragment,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";
import { AgentRunner, type RunnerSettings } from "./runner.js";
import type {
  Blackboard,
  PlanStep,
  EvidenceItem,
  CritiqueRound,
  RoleKind,
  AgentRunSummary,
} from "@shared/types/agents";
import { loadHarness, type HarnessConfig } from "../harness/loader.js";
import { log } from "../../shared/log.js";
import type { MessageBus } from "./messageBus.js";

export interface OrchestratorOptions {
  storage: Storage;
  dataDir: string;
  agentDir: string;
  settings: RunnerSettings;
  /** M3c: 可选 MessageBus。提供后 worker 可问 Communicator 拿额外信息 */
  bus?: MessageBus;
  /** 测试可覆盖:返回 AgentRunner 的工厂 */
  runnerFactory?: (role: RoleKind, id: string | undefined) => AgentRunner;
}

export interface OrchestratorProgress {
  blackboard: Blackboard;
  agents: Record<string, AgentRunSummary>;
}

export type ProgressSink = (p: OrchestratorProgress) => void;

export class Orchestrator {
  private harness: HarnessConfig;
  private runners = new Map<string, AgentRunner>();

  constructor(private opts: OrchestratorOptions) {
    this.harness = loadHarness(opts.dataDir);
  }

  async run(
    conversationId: string,
    goal: string,
    sink: ProgressSink,
    signal?: AbortSignal,
  ): Promise<Blackboard> {
    const bb: Blackboard = {
      conversationId,
      goal,
      plan: [],
      todos: [],
      evidence: [],
      critique: [],
      retrievedMemories: [],
      decisions: [],
      producedArtifacts: [],
      ts: Date.now(),
      version: 1,
      iteration: 0,
      status: "active",
      createdAt: Date.now(),
    };

    // 1. memory
    try {
      const mems = await searchFragmentsByText(this.opts.storage.db, goal, { limit: 5 });
      for (const f of mems) {
        bb.retrievedMemories.push({ fragmentId: f.id, relevance: 0.5 });
      }
      const profs = listProfile(this.opts.storage.db);
      bb.decisions.push({
        iteration: 0,
        ts: Date.now(),
        by: "memory",
        decision: `retrieved ${bb.retrievedMemories.length} fragments, ${profs.length} profile entries`,
      });
    } catch (err) {
      log.warn("orchestrator.memory failed:", err);
      bb.decisions.push({
        iteration: 0,
        ts: Date.now(),
        by: "memory",
        decision: "memory retrieve failed",
      });
    }
    sink({ blackboard: bb, agents: this.collectRunners() });

    const maxIter = this.harness.budget.maxIterations;
    for (let iter = 1; iter <= maxIter; iter++) {
      if (signal?.aborted) break;
      bb.iteration = iter;

      // 2. planner
      const planner = this.getOrCreateRunner("planner");
      const plannerInput =
        `Goal: ${goal}\n\nCurrent Blackboard (truncated):\n` +
        JSON.stringify(
          { plan: bb.plan, evidence: bb.evidence, critique: bb.critique },
          null,
          2,
        ).slice(0, 4000) +
        `\n\nWrite a plan: an array of PlanStep { id, description, status, assignedExecutor }. Output ONLY the JSON array.`;
      const planOutput = await planner.run(plannerInput);
      const plan = this.extractPlan(planOutput);
      bb.plan = plan;
      bb.decisions.push({
        iteration: iter,
        ts: Date.now(),
        by: "planner",
        decision: `proposed ${plan.length} steps`,
      });
      sink({ blackboard: bb, agents: this.collectRunners() });

      // 3. executors (parallel)
      const groups = new Map<string, PlanStep[]>();
      for (const step of plan) {
        const eid = step.assignedExecutor ?? "executor_1";
        if (!groups.has(eid)) groups.set(eid, []);
        groups.get(eid)!.push(step);
      }
      if (groups.size === 0) {
        bb.decisions.push({
          iteration: iter,
          ts: Date.now(),
          by: "executor",
          decision: "no steps to execute (planner produced empty plan)",
        });
      } else {
        await Promise.all(
          Array.from(groups.entries()).map(async ([eid, steps]) => {
            const exec = this.getOrCreateRunner("executor", eid);
            const input =
              `Your steps:\n${JSON.stringify(steps)}\n\nGoal: ${goal}\n\n` +
              `Evidence format per step: { step_id, kind: "observation"|"result"|"data"|"tool_call", content }. ` +
              `Output ONLY a JSON array of EvidenceItem.`;
            const out = await exec.run(input);
            const evidence = this.extractEvidence(out);
            for (const e of evidence) {
              bb.evidence.push({ ...e, executor_id: eid, ts: Date.now() });
            }
          }),
        );
        bb.decisions.push({
          iteration: iter,
          ts: Date.now(),
          by: "executor",
          decision: `${groups.size} executors, ${bb.evidence.length} evidence total`,
        });
      }
      sink({ blackboard: bb, agents: this.collectRunners() });

      // 4. critic
      const critic = this.getOrCreateRunner("critic");
      const evidenceForCrit = bb.evidence.filter((e) =>
        plan.some((p) => p.id === e.step_id),
      );
      const critInput =
        `Goal: ${goal}\n\nPlan: ${JSON.stringify(plan)}\n\nEvidence: ${JSON.stringify(evidenceForCrit)}\n\n` +
        `Reply JSON: { approved: bool, issues: [{severity, message}], suggestions: [string] }. ` +
        `If evidence covers all plan steps, approved=true.`;
      const critOut = await critic.run(critInput);
      const critique = this.extractCritique(critOut, iter);
      bb.critique.push(critique);
      bb.decisions.push({
        iteration: iter,
        ts: Date.now(),
        by: "critic",
        decision: critique.approved
          ? "APPROVED"
          : `rejected: ${critique.issues.length} issues`,
      });
      sink({ blackboard: bb, agents: this.collectRunners() });

      if (critique.approved) {
        bb.status = "approved";
        break;
      }
    }

    if (bb.status === "active") bb.status = "abandoned";

    // 5. reflection
    try {
      const reflector = this.getOrCreateRunner("reflection");
      const reflectInput =
        `Run summary:\n- goal: ${bb.goal}\n- iterations: ${bb.iteration}\n- status: ${bb.status}\n` +
        `- evidence count: ${bb.evidence.length}\n\nWhat should be remembered? Plain text <100 chars.`;
      const reflectOut = await reflector.run(reflectInput);
      if (reflectOut.trim()) {
        insertFragment(this.opts.storage.db, {
          id: nanoid(),
          kind: "context",
          content: `[reflection] ${reflectOut.trim().slice(0, 200)}`,
          sourceConversationId: conversationId,
          sourceMessageId: null,
          importance: 0.5,
          decayFactor: 0.95,
          accessCount: 0,
          lastAccessedAt: null,
          createdAt: Date.now(),
          metadata: null,
        });
      }
    } catch (err) {
      log.warn("orchestrator.reflection failed:", err);
    }

    // 6. persist
    bb.id = upsertBlackboard(this.opts.storage.db, bb);
    sink({ blackboard: bb, agents: this.collectRunners() });

    // 7. cleanup
    for (const r of this.runners.values()) r.dispose();
    return bb;
  }

  abort(): void {
    for (const r of this.runners.values()) r.abort();
  }

  private getOrCreateRunner(role: RoleKind, id?: string): AgentRunner {
    const key = id ? `${role}::${id}` : role;
    let r = this.runners.get(key);
    if (!r) {
      if (this.opts.runnerFactory) {
        r = this.opts.runnerFactory(role, id);
      } else {
        r = new AgentRunner(
          role,
          this.opts.settings,
          `${this.opts.agentDir}/${role}/${id ?? "default"}`,
          process.cwd(),
          this.harness.systemPrompts[role] ?? "",
          this.harness.budget.perStepTimeoutMs,
        );
      }
      // M3c: 注入 bus 让 worker 可问 Communicator
      if (this.opts.bus) r.bus = this.opts.bus;
      this.runners.set(key, r);
    }
    return r;
  }

  private collectRunners(): Record<string, AgentRunSummary> {
    const out: Record<string, AgentRunSummary> = {};
    for (const [k, r] of this.runners) out[k] = r.toSummary();
    return out;
  }

  private extractPlan(text: string): PlanStep[] {
    const m = text.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    try {
      const v = JSON.parse(m[0]);
      if (!Array.isArray(v)) return [];
      return v.map((s: Record<string, unknown>) => ({
        id: String(s.id ?? nanoid(6)),
        description: String(s.description ?? ""),
        status: (s.status as PlanStep["status"]) ?? "pending",
        assignedExecutor: (s.assignedExecutor as string | undefined) ?? undefined,
        resultSummary: (s.resultSummary as string | undefined) ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  private extractEvidence(text: string): EvidenceItem[] {
    const m = text.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    try {
      const v = JSON.parse(m[0]);
      if (!Array.isArray(v)) return [];
      return v.map((e: Record<string, unknown>) => ({
        step_id: String(e.step_id ?? ""),
        executor_id: String(e.executor_id ?? ""),
        kind: (e.kind as EvidenceItem["kind"]) ?? "observation",
        content: String(e.content ?? ""),
        ts: 0,
      }));
    } catch {
      return [];
    }
  }

  private extractCritique(text: string, iteration: number): CritiqueRound {
    const m = text.match(/\{[\s\S]*?\}/);
    let approved = false;
    let issues: CritiqueRound["issues"] = [];
    let suggestions: string[] = [];
    if (m) {
      try {
        const v = JSON.parse(m[0]);
        approved = !!v.approved;
        if (Array.isArray(v.issues)) {
          issues = v.issues.map((i: Record<string, unknown>) => ({
            severity: i.severity === "major" ? "major" : "minor",
            message: String(i.message ?? ""),
          }));
        }
        if (Array.isArray(v.suggestions)) {
          suggestions = v.suggestions.map((s: unknown) => String(s));
        }
      } catch {
        /* parse fail */
      }
    }
    if (!m && /APPROVE/i.test(text)) approved = true;
    return {
      iteration,
      critic_id: "critic_default",
      approved,
      issues,
      suggestions,
      ts: Date.now(),
    };
  }
}