/**
 * Sansheng · Harness Manager v0 (M3+ B4)
 *
 * 只读实现预览生成器 — 它**绝不写文件**(M6 真 apply 才是后续 plan)。
 *
 * 职责:
 *   1. 订阅 bus `artifact_created`
 *   2. 过滤 `kind === 'harness_proposal' && status === 'open'`
 *   3. LLM decide → `implementation_preview` artifact(markdown body)
 *   4. 风险分类由 LLM 自评,透传到 metadata
 *   5. 写回 global blackboard + emit `artifact_created`
 *   6. high-risk → 通过 `notifyUser` 回调发送 user message(v0 不实现 apply)
 *
 * 设计点:
 *   - 单例(`HarnessManager.start(opts)` 启动一次)
 *   - `decideFn` 注入 — 测试可换 FakeLLM,生产走 Pi session + harness prompt
 *   - `notifyUser` 注入 — 默认 no-op;server boot 接 kernel EventSink 把
 *     `{ type: "harness_user_notice", previewId, conversationId, text }`
 *     转给 WS 层(由前端显示 toast)
 *   - **不读不写项目文件**:绝不在此模块 import `node:fs` / `node:fs/promises`;
 *     源码预览从 proposal.body / metadata.filesToChange 派生,LLM 自决
 *   - inFlight 集合保证同一 proposalId 不会并发触发多次 LLM call
 *   - 已生成 preview 的 proposalId 记到 `seen`,避免重启后重复生成
 *     (重启时 `seen` 为空,但 Storage 中的 `implementation_preview.refs` 仍
 *     含 proposalId → 用 `existingPreviewFor()` 防御)
 *
 * 启动流程(server boot):
 *   const harness = HarnessManager.start({
 *     storage,
 *     systemPrompt: harness.systemPrompts.harness ?? DEFAULT_PROMPT,
 *     decideFn: harnessDecideFn,           // 生产:真 LLM
 *     notifyUser: (text) => sink(...),     // 生产:kernel EventSink
 *   });
 *   ...
 *   harness.stop();
 */

import { log } from "../../shared/log.js";
import type { BlackboardArtifact, FileChange } from "../../../shared/types/blackboard.js";
import type { BusEventPayload } from "../../../shared/types/bus.js";
import {
  parseHarnessPreview,
  type RawHarnessPreview,
  type ImplementationPreviewPayload,
} from "../../../shared/types/harness.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import { upsertArtifact, listArtifacts } from "../storage/repo/blackboards.js";
import type { Storage } from "../storage/db.js";

// ───────────────────────────── Decide / Notify 注入 ─────────────────────────────

/**
 * Harness Manager 给 LLM 的输入。
 *   - proposal: 上游 LLM 提出的工装改造方案
 *   - relatedArtifacts: proposal.refs 解析出的 artifact 列表(可能为空)
 *   - previewedBefore: 历史上是否已为这条 proposal 生成过 preview(防御重跑)
 */
export interface HarnessDecideInput {
  proposal: BlackboardArtifact;
  relatedArtifacts: BlackboardArtifact[];
  previewedBefore: boolean;
}

/**
 * LLM 决定 — 返回纯字符串(由 HarnessManager 自己 parse)。
 * 不返回结构体是为了让 LLM 客户端实现更自由(可走 prompt 解析、可走
 * tool call JSON、可走原始字符串截取)。
 */
export type HarnessDecideFn = (input: HarnessDecideInput) => Promise<string>;

/**
 * 高风险 preview 通知 user 的回调。
 * 接收已经渲染好的中文短文本(包含 riskLevel + previewId + title)。
 * 失败不应 throw — Harness Manager 仅 log.warn。
 */
export type HarnessNotifyUserFn = (input: {
  previewId: string;
  proposalId: string;
  riskLevel: "low" | "medium" | "high";
  title: string;
  text: string;
  conversationId?: string;
}) => void;

// ───────────────────────────── Options ─────────────────────────────

export interface HarnessManagerOptions {
  storage: Storage;
  /** system prompt — 从 harness loader 读;若空用内置 fallback。 */
  systemPrompt?: string;
  /** LLM 决策函数(注入式)。生产走 Pi session,测试用 FakeLLM。 */
  decideFn: HarnessDecideFn;
  /** user 通知回调(可选;不传则 high-risk 只 log)。 */
  notifyUser?: HarnessNotifyUserFn;
  /** 测试用:覆盖日志(默认 log.warn)。 */
  warn?: (msg: string, ...rest: unknown[]) => void;
  info?: (msg: string, ...rest: unknown[]) => void;
}

// ───────────────────────────── HarnessManager ─────────────────────────────

/**
 * 默认 harness 系统 prompt(若 harness loader 没读到对应文件)。
 * 同步嵌入的简短版 — 完整版在 `shared/prompts/harness.md`。
 */
const FALLBACK_HARNESS_PROMPT = `# Harness Manager v0

你是 Harness Manager — 三生系统的工装升级顾问。
绝不写文件,只生成只读的 implementation preview。
输出严格 JSON(无 markdown wrapper):

{
  "previewMarkdown": "<markdown 预览>",
  "riskLevel": "low"|"medium"|"high",
  "targetFiles": ["src/..."],
  "estimatedLines": <number>,
  "mode": "create"|"modify"|"refactor"
}

previewMarkdown 必须用 markdown,代码块 \`\`\`ts 包裹,
顶部注释 // <relative path> 表明目标文件。
150-600 字,章节:概要 / 目标文件 + 改动 / 风险与注意事项。`;

export class HarnessManager {
  /** 已处理过(或正在处理)的 proposalId — 内存去重。 */
  private readonly seen = new Set<string>();
  /** 正在跑的 proposalId — 防御同 proposal 的并发订阅。 */
  private readonly inFlight = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(private readonly opts: HarnessManagerOptions) {}

  /**
   * 启动 bus 订阅。重复调用是 no-op。
   * 返回 unsubscribe 函数。
   */
  start(): () => void {
    if (this.started) return this.stop.bind(this);
    this.started = true;
    this.opts.info?.("[harness] started, subscribing artifact_created");
    this.unsubscribe = artifactBus.subscribe("artifact_created", (e) => {
      void this.handleEvent(e).catch((err) => {
        this.warn("handleEvent threw:", err);
      });
    });
    return this.stop.bind(this);
  }

  /**
   * 停止 bus 订阅。
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.unsubscribe?.();
    } catch (err) {
      this.warn("unsubscribe threw:", err);
    }
    this.unsubscribe = null;
    this.seen.clear();
    this.inFlight.clear();
    this.opts.info?.("[harness] stopped");
  }

  /** 测试用:看某 proposal 是否已生成 preview(内存或 storage)。 */
  hasSeen(proposalId: string): boolean {
    return this.seen.has(proposalId);
  }

  // ── 事件入口 ─────────────────────────────────────────────────

  private async handleEvent(event: BusEventPayload<"artifact_created">): Promise<void> {
    const artifact = event.artifact;
    if (!artifact) return;
    if (artifact.kind !== "harness_proposal") return;
    if (artifact.status !== "open") return;

    const proposalId = artifact.id;
    if (this.inFlight.has(proposalId)) return;
    if (this.seen.has(proposalId)) return;

    // 防御重跑:storage 里已有 preview 关联到此 proposal → 跳过
    if (this.existingPreviewFor(proposalId)) {
      this.seen.add(proposalId);
      this.opts.info?.(`[harness] skip ${proposalId} — preview already exists`);
      return;
    }

    this.inFlight.add(proposalId);
    try {
      await this.processProposal(artifact);
    } finally {
      this.inFlight.delete(proposalId);
      this.seen.add(proposalId);
    }
  }

  private existingPreviewFor(proposalId: string): BlackboardArtifact | null {
    try {
      const list = listArtifacts(this.opts.storage.db, {
        scope: "global",
        kind: "implementation_preview",
        limit: 200,
      });
      for (const a of list) {
        if (a.refs && a.refs.includes(proposalId)) return a;
      }
    } catch (err) {
      this.warn("existingPreviewFor scan failed:", err);
    }
    return null;
  }

  // ── 核心流程 ─────────────────────────────────────────────────

  private async processProposal(proposal: BlackboardArtifact): Promise<void> {
    this.opts.info?.(
      `[harness] processing proposal ${proposal.id} "${proposal.title}"`,
    );

    // 1. 收集 relatedArtifacts(refs → 实体)
    const relatedArtifacts = this.resolveRefs(proposal.refs);

    // 2. 决定(LLM / Fake)
    const prompt = this.opts.systemPrompt ?? FALLBACK_HARNESS_PROMPT;
    const userInput = this.buildUserInput(proposal, relatedArtifacts, prompt);

    let rawOutput: string;
    try {
      rawOutput = await this.opts.decideFn({
        proposal,
        relatedArtifacts,
        previewedBefore: false,
      });
    } catch (err) {
      // LLM call 失败 → 写 fallback note artifact,让用户/UI 看到失败
      this.warn(`decideFn threw for ${proposal.id}:`, err);
      this.writeFailureNote(proposal, (err as Error).message ?? String(err));
      return;
    }

    // 3. parse
    const parsed = parseHarnessPreview(rawOutput);
    if (!parsed.ok) {
      this.warn(`parse failed for ${proposal.id}: ${parsed.error}`);
      this.writeFailureNote(proposal, parsed.error, parsed.raw);
      return;
    }

    // 4. 写 implementation_preview artifact
    const preview = this.buildPreviewArtifact(proposal, parsed.value);
    try {
      upsertArtifact(this.opts.storage.db, preview);
    } catch (err) {
      this.warn(`upsertArtifact(preview) failed for ${proposal.id}:`, err);
      return;
    }
    artifactBus.publish({ type: "artifact_created", artifact: preview });
    this.warn(
      `[harness] preview ${preview.id} emitted for ${proposal.id} (risk=${parsed.value.riskLevel}, mode=${parsed.value.mode}, files=${parsed.value.targetFiles.length})`,
    );

    // 5. high-risk → notify user(v0 不 apply,只描述 + 标记 ready)
    if (preview.metadata?.riskLevel === "high") {
      this.notifyHighRisk(proposal, preview, parsed.value);
    }
  }

  // ── 工具方法 ─────────────────────────────────────────────────

  private resolveRefs(refs: string[] | undefined): BlackboardArtifact[] {
    if (!refs || refs.length === 0) return [];
    const out: BlackboardArtifact[] = [];
    // 这里用 listArtifacts(global) 一次性扫,避免 N 次 getArtifact
    try {
      const all = listArtifacts(this.opts.storage.db, {
        scope: "global",
        limit: 500,
      });
      const byId = new Map(all.map((a) => [a.id, a]));
      for (const id of refs) {
        const a = byId.get(id);
        if (a) out.push(a);
      }
    } catch (err) {
      this.warn("resolveRefs scan failed:", err);
    }
    return out;
  }

  private buildUserInput(
    proposal: BlackboardArtifact,
    related: BlackboardArtifact[],
    systemPrompt: string,
  ): string {
    // user input 只是把 system prompt 外的 context 拼起来;
    // 实际 LLM call 由 decideFn 自己负责包装 system + user。
    // 这里暴露给 decideFn 的 `prompt` 字段,让生产 LLM 客户端按惯例使用。
    const proposalBlock = [
      `## Proposal (id=${proposal.id})`,
      `title: ${proposal.title}`,
      `category: ${proposal.metadata?.category ?? "(unspecified)"}`,
      `riskLevel (proposal self-eval): ${proposal.metadata?.riskLevel ?? "(unspecified)"}`,
      `estimatedEffort: ${proposal.metadata?.estimatedEffort ?? "(unspecified)"}`,
      "",
      "body:",
      proposal.body,
    ].join("\n");

    const filesBlock =
      proposal.metadata?.filesToChange && proposal.metadata.filesToChange.length > 0
        ? [
            "## filesToChange (from proposal metadata)",
            ...proposal.metadata.filesToChange.map(
              (f: FileChange) => `- ${f.changeType}: ${f.path}${f.diffPreview ? `\n  preview: ${f.diffPreview.slice(0, 200)}` : ""}`,
            ),
          ].join("\n")
        : "";

    const relatedBlock =
      related.length > 0
        ? [
            "## relatedArtifacts",
            ...related.map(
              (a) =>
                `- ${a.id} [${a.kind}/${a.status}] ${a.title}\n  ${a.body.slice(0, 240)}${a.body.length > 240 ? "..." : ""}`,
            ),
          ].join("\n")
        : "";

    return [
      "system prompt:",
      "<<<" + systemPrompt + ">>>",
      "",
      proposalBlock,
      filesBlock,
      relatedBlock,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildPreviewArtifact(
    proposal: BlackboardArtifact,
    raw: RawHarnessPreview,
  ): BlackboardArtifact {
    const payload: ImplementationPreviewPayload = {
      proposalId: proposal.id,
      riskLevel: raw.riskLevel,
      targetFiles: raw.targetFiles,
      estimatedLines: raw.estimatedLines,
      mode: raw.mode,
    };
    // 显式 omit `callbackReason`(只 hypothesis artifact 用,preview 不应有)
    const { callbackReason: _omit, ...proposalMeta } = proposal.metadata ?? {};

    return makeArtifact({
      scope: "global",
      kind: "implementation_preview",
      title: `Preview for: ${proposal.title}`,
      body: raw.previewMarkdown,
      refs: [proposal.id],
      author: "harness_manager",
      status: "open",
      metadata: {
        ...proposalMeta,
        ...payload,
        category: proposal.metadata?.category,
      },
    });
  }

  private writeFailureNote(
    proposal: BlackboardArtifact,
    errorMsg: string,
    raw?: string,
  ): void {
    const safeRaw = raw ? raw.slice(0, 200) : "(no raw)";
    const note = makeArtifact({
      scope: "global",
      kind: "note",
      title: `Harness preview failed for: ${proposal.title}`,
      body: [
        `无法为 proposal ${proposal.id} 生成 implementation preview。`,
        "",
        `错误:${errorMsg}`,
        "",
        "原始 LLM 输出(前 200 字):",
        "```",
        safeRaw,
        "```",
      ].join("\n"),
      refs: [proposal.id],
      author: "harness_manager",
      status: "failed",
      metadata: {
        riskLevel: "high",
        proposalId: proposal.id,
        errorMsg,
      },
    });
    try {
      upsertArtifact(this.opts.storage.db, note);
      artifactBus.publish({ type: "artifact_created", artifact: note });
      this.opts.info?.(
        `[harness] failure-note ${note.id} emitted for ${proposal.id}`,
      );
    } catch (err) {
      this.warn(`writeFailureNote upsert failed for ${proposal.id}:`, err);
    }
  }

  private notifyHighRisk(
    proposal: BlackboardArtifact,
    preview: BlackboardArtifact,
    raw: RawHarnessPreview,
  ): void {
    if (!this.opts.notifyUser) {
      this.opts.info?.(
        `[harness] high-risk preview ${preview.id} — no notifyUser wired`,
      );
      return;
    }
    const text = [
      `⚠️ Harness 高风险预览就绪(待人工批准,不会自动 apply):`,
      `• Proposal: ${proposal.title}`,
      `• 风险等级: high`,
      `• 改动模式: ${raw.mode}`,
      `• 估算行数: ~${raw.estimatedLines}`,
      `• 目标文件: ${raw.targetFiles.slice(0, 4).join(", ")}${raw.targetFiles.length > 4 ? ` 等 ${raw.targetFiles.length} 个` : ""}`,
      `• Preview: ${preview.id}`,
      "",
      `(M6 apply 阶段尚未实现;此消息仅作记录与提示)`,
    ].join("\n");
    try {
      this.opts.notifyUser({
        previewId: preview.id,
        proposalId: proposal.id,
        riskLevel: "high",
        title: proposal.title,
        text,
        conversationId: proposal.conversationId,
      });
    } catch (err) {
      this.warn("notifyUser threw:", err);
    }
  }

  private warn(msg: string, ...rest: unknown[]): void {
    if (this.opts.warn) {
      this.opts.warn(msg, ...rest);
    } else {
      log.warn(msg, ...rest);
    }
  }
}

// ───────────────────────────── Singleton helper ─────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __sanshengHarnessManager: HarnessManager | undefined;
}

/**
 * 拿到全局 HarnessManager 单例(若没有就建一个,默认 no-op decide —
 * server boot 必须先调 `setHarnessManager()` 注入真 LLM)。
 *
 * 单例守护与 `artifactBus` 同样的 globalThis 模式。
 */
export function getHarnessManager(): HarnessManager | undefined {
  return globalThis.__sanshengHarnessManager;
}

export function setHarnessManager(mgr: HarnessManager): void {
  globalThis.__sanshengHarnessManager = mgr;
}
