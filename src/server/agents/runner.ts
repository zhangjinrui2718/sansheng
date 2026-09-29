/**
 * Sansheng AgentRunner · M3b
 *
 * 包装 @earendil-works/pi-coding-agent 的 createAgentSession,提供:
 * - 一次性 start() 创建 session
 * - run(input) 发送 + 等待流结束(超时强制 abort)
 * - toSummary() 导出 AgentRunSummary 供 UI / Orchestrator 用
 *
 * 注意 Pi SDK 实际 API(0.87.1):
 *   - session.prompt(text, opts?) 返回 Promise<void>(resolve on completion)
 *   - session.abort() 返回 Promise<void>
 *   - session.dispose() 非可选
 *   - session.isStreaming / session.isIdle 不在公开 API 上 → cast 后再用
 *   - session.sendUserMessage(...) 用于 additional turn
 *
 * 因此最干净的"等流结束"做法:直接 await prompt();超时则并行调 abort()。
 */
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { nanoid } from "nanoid";
import { resolveModel } from "../providers/registry.js";
import { log } from "../../shared/log.js";
import type { RoleKind, AgentRunSummary } from "@shared/types/agents";

export interface RunnerSettings {
  provider: string;
  baseUrl?: string;
  apiKey: string;
  modelId: string;
  thinkingLevel: string;
}

export class AgentRunner {
  role: RoleKind;
  status: AgentRunSummary["status"] = "idle";
  inputPreview = "";
  outputPreview = "";
  lastUsage: AgentRunSummary["usage"];
  startedAt = 0;
  session: AgentSession | null = null;
  private readonly runnerId = nanoid();

  constructor(
    role: RoleKind,
    private settings: RunnerSettings,
    private agentDir: string,
    private cwd: string,
    private systemPrompt: string,
    private timeoutMs: number = 60000,
  ) {
    this.role = role;
  }

  async start(): Promise<void> {
    const model = resolveModel(this.settings as unknown as Parameters<typeof resolveModel>[0]);
    if (!model) {
      throw new Error(
        `AgentRunner(${this.role}): cannot resolve model ${this.settings.provider}/${this.settings.modelId}`,
      );
    }
    const result = await createAgentSession({
      model: model as Model<string>,
      agentDir: this.agentDir,
      cwd: this.cwd,
    });
    this.session = result.session;
    this.startedAt = Date.now();
  }

  /**
   * 向 session 发送输入,等到 prompt() resolve(完成)或超时。返回 inputPreview 兜底文本。
   */
  async run(input: string): Promise<string> {
    if (!this.session) await this.start();
    this.status = "thinking";
    this.inputPreview = input.slice(0, 200);
    const fullInput = this.systemPrompt
      ? `${this.systemPrompt}\n\n---\n\n${input}`
      : input;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        try {
          void this.session?.abort();
        } catch {
          /* ignore */
        }
        this.status = "aborted";
        resolve(`[${this.role}] timeout after ${this.timeoutMs}ms`);
      }, this.timeoutMs);
    });

    const runPromise = (async (): Promise<string> => {
      try {
        await this.session!.prompt(fullInput);
      } catch (err) {
        log.warn(`AgentRunner(${this.role}).prompt failed:`, err);
        return `[${this.role}] prompt failed: ${(err as Error).message ?? String(err)}`;
      }
      return `[${this.role}] processed`;
    })();

    const lastText = await Promise.race([runPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    // status 可能是 "thinking"(run 胜出)、"aborted"(timeout 胜出)
    if (this.status === "thinking") this.status = "done";
    this.outputPreview = lastText.slice(0, 500);
    return lastText;
  }

  abort(): void {
    try {
      void this.session?.abort();
    } catch {
      /* ignore */
    }
    this.status = "aborted";
  }

  dispose(): void {
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = null;
  }

  toSummary(): AgentRunSummary {
    const ended =
      this.status === "done" ||
      this.status === "failed" ||
      this.status === "aborted"
        ? Date.now()
        : undefined;
    return {
      role: this.role,
      sessionId: this.runnerId,
      startedAt: this.startedAt,
      endedAt: ended,
      status: this.status,
      inputPreview: this.inputPreview,
      outputPreview: this.outputPreview,
      usage: this.lastUsage,
    };
  }
}