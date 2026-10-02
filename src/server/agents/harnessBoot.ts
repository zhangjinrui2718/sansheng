/**
 * Sansheng · HarnessManager boot 接线(批次 5b-2 · T2)
 *
 * 审查 §B1(docs/CODE-REVIEW-2026-10-01.md):harnessManager.ts 562 行生产从不
 * 启动 = 死代码。本模块是「让它活」的最小接线:
 *
 *   bootHarnessManager({ storage, kernel })
 *     → new HarnessManager(真实依赖).start()   订阅 artifactBus artifact_created
 *     → setHarnessManager(单例)                GET /api/harness 读运行态
 *
 * 生产 decideFn = completeSimple(kernel.getModel())(ws.ts makeLlmCall /
 * decide LLM / 沉淀服务同款模式):systemPrompt = harness prompt(默认内置
 * FALLBACK_HARNESS_PROMPT),userPrompt = proposal 详情(buildHarnessDecidePrompt)。
 * 测试注入 seam = opts.decideFn(绕过模型闸门,显式注入 = 显式测试意图)。
 *
 * notifyUser 刻意**不接**:v0 高风险 preview 只 log(manager 自带降级)+
 * preview artifact 本身经 artifact_created 到达 UI(批次 1/3 链路);toast 级
 * 通知需要新 ServerEvent 类型(动 ws 广播结构),留给 UI 批次。
 *
 * proposals 生产来源(诚实结论):当前代码库无任何 harness_proposal artifact
 * 发射点(executor 的 D13 callbackReason 读取路径错位 = 审查 §B1①,5c 修;
 * 沉淀服务 kind 白名单刻意不含 harness_proposal —— 聊天转录提不出合格的
 * D13 metadata,强行接线 = 垃圾 proposal → 垃圾 preview 自放大)。manager
 * 启动即订阅待命,/api/harness 如实返回空 proposals + 说明字段,不造假数据。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { log } from "../../shared/log.js";
import type { AgentKernel } from "../kernel/agentKernel.js";
import { loadHarness } from "../harness/loader.js";
import type { Storage } from "../storage/db.js";
import type { FileChange } from "../../../shared/types/blackboard.js";
import {
  FALLBACK_HARNESS_PROMPT,
  HarnessManager,
  getHarnessManager,
  setHarnessManager,
  type HarnessDecideFn,
  type HarnessDecideInput,
  type HarnessNotifyUserFn,
} from "./harnessManager.js";

/**
 * decideFn 只需要 kernel 的模型解析口(避免整 kernel 依赖,测试易桩)。
 * getApiKey:B6(审查 §B6)同款 —— 显式把 key 交给 completeSimple,不进 process.env。
 */
export interface HarnessBootKernel {
  getModel(): Model<any> | null;
  getApiKey?(): string | undefined;
}

export interface HarnessBootOptions {
  storage: Storage;
  kernel: Pick<AgentKernel, "getModel" | "getModelApiKey">;
  /**
   * 批次 7-G:数据目录 —— 用来读 `harness/system_prompts/harness_manager.md`。
   * 不传(旧调用方 / 多数测试)→ 直接用 FALLBACK_HARNESS_PROMPT,行为与 7-G 前一致。
   */
  dataDir?: string;
  /**
   * 覆盖 harness system prompt。**优先级高于 harness 文件**;都不给时回退
   * FALLBACK_HARNESS_PROMPT(内置精简版)。
   */
  systemPrompt?: string;
  /** DI seam(测试注入);不传 → 生产 completeSimple(kernel.getModel())。 */
  decideFn?: HarnessDecideFn;
  /** 高风险 preview 通知回调;boot 默认不接(见文件头注释)。 */
  notifyUser?: HarnessNotifyUserFn;
  /** decideFn 超时;默认沿用 manager 的 60s。 */
  decideTimeoutMs?: number;
}

/** boot 元信息 — GET /api/harness 的「manager 运行态」补充字段。 */
export interface HarnessBootMeta {
  startedAt: number;
  decideSource: "production-llm" | "injected";
}

let bootMeta: HarnessBootMeta | null = null;

/** 最近一次 bootHarnessManager 的元信息;从未 boot / 已 stop 后仍返回(供诊断)。 */
export function getHarnessBootMeta(): HarnessBootMeta | null {
  return bootMeta;
}

/**
 * 生产 decideFn 的 userPrompt:proposal 详情 + filesToChange + relatedArtifacts。
 * 结构与 HarnessManager.buildUserInput(私有)同源,但不内嵌 systemPrompt ——
 * system 走 completeSimple 的 systemPrompt 参数(职责分离)。
 */
export function buildHarnessDecidePrompt(input: HarnessDecideInput): string {
  const { proposal, relatedArtifacts, previewedBefore } = input;
  const proposalBlock = [
    `## Proposal (id=${proposal.id})`,
    `title: ${proposal.title}`,
    `category: ${proposal.metadata?.category ?? "(unspecified)"}`,
    `riskLevel (proposal self-eval): ${proposal.metadata?.riskLevel ?? "(unspecified)"}`,
    `estimatedEffort: ${proposal.metadata?.estimatedEffort ?? "(unspecified)"}`,
    `previewedBefore: ${previewedBefore}`,
    "",
    "body:",
    proposal.body,
  ].join("\n");

  const filesBlock =
    proposal.metadata?.filesToChange && proposal.metadata.filesToChange.length > 0
      ? [
          "## filesToChange (from proposal metadata)",
          ...proposal.metadata.filesToChange.map(
            (f: FileChange) =>
              `- ${f.changeType}: ${f.path}${f.diffPreview ? `\n  preview: ${f.diffPreview.slice(0, 200)}` : ""}`,
          ),
        ].join("\n")
      : "";

  const relatedBlock =
    relatedArtifacts.length > 0
      ? [
          "## relatedArtifacts",
          ...relatedArtifacts.map(
            (a) =>
              `- ${a.id} [${a.kind}/${a.status}] ${a.title}\n  ${a.body.slice(0, 240)}${a.body.length > 240 ? "..." : ""}`,
          ),
        ].join("\n")
      : "";

  return [proposalBlock, filesBlock, relatedBlock].filter(Boolean).join("\n\n");
}

/** 生产 decideFn:completeSimple(kernel.getModel());无模型 → throw(manager 写失败 note)。 */
export function makeProductionHarnessDecideFn(
  kernel: HarnessBootKernel,
  systemPrompt: string,
): HarnessDecideFn {
  return async (input: HarnessDecideInput): Promise<string> => {
    const model = kernel.getModel();
    if (!model) {
      throw new Error("harness decide: no resolved model (kernel not started?)");
    }
    const apiKey = kernel.getApiKey?.();
    const result = await completeSimple(
      model as Parameters<typeof completeSimple>[0],
      {
        systemPrompt,
        messages: [
          { role: "user", content: buildHarnessDecidePrompt(input), timestamp: Date.now() },
        ],
      },
      apiKey ? { apiKey } : undefined,
    );
    if (result.stopReason === "error" || result.errorMessage) {
      throw new Error(result.errorMessage ?? "completeSimple error");
    }
    const out: string[] = [];
    for (const c of result.content) {
      if (c.type === "text") out.push(c.text);
    }
    return out.join("");
  };
}

/**
 * server boot 接线(index.ts startServer 调用;测试可直接调用)。
 * 幂等守护:已有单例先 stop(防同进程双订阅重复处理),再建再 start。
 */
export function bootHarnessManager(opts: HarnessBootOptions): HarnessManager {
  const existing = getHarnessManager();
  if (existing) {
    try {
      existing.stop();
    } catch {
      /* ignore */
    }
  }
  // 批次 7-G:优先 harness system_prompts/harness_manager.md(空则回退编译内置)。
  // 与其余单元同一套语义:harness 值非空才用,否则用 FALLBACK_HARNESS_PROMPT。
  const harnessPrompt = opts.dataDir
    ? loadHarness(opts.dataDir).systemPrompts["harness_manager"]
    : "";
  const systemPrompt =
    opts.systemPrompt ?? (harnessPrompt.trim() ? harnessPrompt : FALLBACK_HARNESS_PROMPT);
  const injected = opts.decideFn !== undefined;
  const mgr = new HarnessManager({
    storage: opts.storage,
    // 批次 7-G:管理面需要 dataDir 才能按需读各面
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    systemPrompt,
    decideFn: opts.decideFn ?? makeProductionHarnessDecideFn(opts.kernel, systemPrompt),
    ...(opts.notifyUser ? { notifyUser: opts.notifyUser } : {}),
    ...(opts.decideTimeoutMs !== undefined ? { decideTimeoutMs: opts.decideTimeoutMs } : {}),
  });
  mgr.start();
  setHarnessManager(mgr);
  bootMeta = { startedAt: Date.now(), decideSource: injected ? "injected" : "production-llm" };
  log.info(`harness manager: booted (decideSource=${bootMeta.decideSource})`);
  return mgr;
}
