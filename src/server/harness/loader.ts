/**
 * Sansheng Harness loader · M3b
 *
 * Harness = 用户/开发者可改的"运行规约":
 *   system_prompts/{role}.md    每个 agent 角色的 system prompt
 *   enabled_tools.json          工具白名单(M3c)
 *   policies/...json             routing / retry / budget / red lines (M3c/M6)
 *
 * M3b 只实现:
 *   - ensureHarness(): 首次启动时生成 5 个默认 prompt md 文件(若不存在)
 *   - loadHarness():   读取 prompt 文件,合并默认 config
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleKind } from "@shared/types/agents";

export interface HarnessConfig {
  systemPrompts: Record<RoleKind, string>;
  enabledTools: string[];
  redLines: string[];
  budget: { maxIterations: number; perStepTimeoutMs: number; maxCostUsd: number };
}

const DEFAULT_CONFIG: HarnessConfig = {
  systemPrompts: {
    communicator: "",
    planner: "",
    executor: "",
    critic: "",
    memory: "",
    reflection: "",
  },
  enabledTools: ["fs_read", "fs_write", "shell", "http"],
  redLines: ["禁止修改 .ssh/", "禁止外发邮件"],
  budget: { maxIterations: 5, perStepTimeoutMs: 60000, maxCostUsd: 0.5 },
};

const DEFAULT_PROMPTS: Record<RoleKind, string> = {
  communicator: `# Communicator (沟通员)
你的职责:
- 接收用户消息,先判断是 chat(闲聊直接答)/ task(转 Planner 跑多 agent)/ feedback(更新用户画像)
- Worker 通过 MessageBus 提问时,先尽力自查(查代码 / 调工具);答不了再升级用户
- 用对话风格落平衡(简短、口语化,不要长篇暴露)

约束:
- 一次只发一条 chat 回复;task 转发后等 worker 回报再回话
- 升级用户前先尝试自查(读 README / 看相关文件)
- 保持角色一致:用「三生」第一人称`,
  planner: `# Planner (规划师)
你的职责:
- 阅读用户目标和当前 Blackboard
- 拆解为有序的 plan steps
- 给每个 step 指定 executor_id
- 写回 Blackboard.plan

约束:
- plan 不超过 8 steps
- 每个 step 必须有可验证的成功标准
- 简单任务不要用多 agent`,
  executor: `# Executor (执行者)
你的职责:
- 接收 plan 中 assigned 给你的 steps
- 执行 step,产出 evidence
- 写到 Blackboard.evidence

约束:
- 不要碰 assigned 范围外的 steps
- 失败要写 evidence,不要静默吞错
- 工具调用前先确认 sandbox`,
  critic: `# Critic (评审者)
你的职责:
- 评估 Blackboard.evidence 是否达到 plan 目标
- 写 CritiqueRound

约束:
- 严判但不吹毛求疵
- approve 条件:所有 plan steps 完成 + evidence 覆盖目标
- 不要 approve 空 evidence`,
  memory: `# Memory (记忆维护者)
你的职责:
- 维护 fragments + user_profile
- 决定什么值得存进长期记忆

约束:
- 重复信息合并
- 冲突信息触发用户裁决
- 噪音不存`,
  reflection: `# Reflection (反思者)
你的职责:
- 每个多 agent run 结束后回顾
- 提炼 memory fragment candidates

约束:
- 反思要简洁 (<100 字)
- 重点是「下次怎么做更好」
- 不要重复已有 memory`,
};

/**
 * 在 dataDir/harness/system_prompts/ 下生成默认 md 文件(已存在则跳过)。
 * 这给用户提供一个"先跑起来再调"的基线。
 */
export function ensureHarness(dataDir: string): void {
  const harnessDir = join(dataDir, "harness");
  const promptsDir = join(harnessDir, "system_prompts");
  if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true });
  for (const [role, content] of Object.entries(DEFAULT_PROMPTS)) {
    const p = join(promptsDir, `${role}.md`);
    if (!existsSync(p)) writeFileSync(p, content, "utf-8");
  }
}

/**
 * 加载 harness 配置:始终以 DEFAULT_CONFIG 为底,prompt md 文件覆盖默认空串。
 * 用户编辑 md 文件 → 下次 loadHarness 拿到新 prompt(不需重启, server 可在每个 Orchestrator 创建时重新 load)。
 */
export function loadHarness(dataDir: string): HarnessConfig {
  const harnessDir = join(dataDir, "harness");
  const config = structuredClone(DEFAULT_CONFIG);
  for (const role of Object.keys(config.systemPrompts) as RoleKind[]) {
    const p = join(harnessDir, "system_prompts", `${role}.md`);
    if (existsSync(p)) {
      try {
        config.systemPrompts[role] = readFileSync(p, "utf-8");
      } catch {
        // 读取失败保留默认空串
      }
    }
  }
  return config;
}