/**
 * 平台运行时 · 提示词装配(设计 1 §7.2)
 *
 * ── 为什么必须有这一层 ──────────────────────────────────────────
 *
 * 首跑冒烟时,业务经理回答自己是「AI 编码助手」—— 因为**提示词单元算出来了
 * 却从没送达模型**。这正是 7-B 的形态:
 *
 *   「7-B 之前这段是**死接线**(this.dataDir 存了没用,spawn 只传 { storage }),
 *    Planner/Executor 一直拿模块内 6-9 行 stub,shared/prompts/planner.md 那份
 *    91 行正经提示词是死代码。**改提示词前先确认它真的到达模型**。」
 *
 * 那一课在这里的落点:`planAgentSession` 返回的 `promptUnits` **必须**被真的
 * 拼进系统提示,否则它就是这个项目踩过三次的同一类谎话。
 *
 * ── 两层内容,来源不同 ──────────────────────────────────────────
 *
 * **① 角色简报(机械生成,来自代码)**
 *   从 `ROLE_SPECS` 渲染:你是什么角色、能做什么、不能做什么。
 *   它是**机器可读事实的转写**,不是创作 —— 所以由代码生成,永远不会与
 *   授权模型脱节。改 ROLE_SPECS,简报自动跟着变。
 *
 * **② 提示词单元(内容,来自盘上 md)**
 *   `harness/system_prompts/{unitId}.md`。这里只管**装载与拼装**,
 *   不负责内容 —— 内容是行为设计,归 harness 管理面(7-O 的写盘规矩:
 *   备份是写的前置、报成功 = 真生效)。
 *
 * **缺失单元如实报出,不静默吞掉**。一个没写出来的单元等于那条职责根本没有
 * 告诉过 agent —— 而它会照常工作,只是不知道那条规矩。这种「静默降级」比报错
 * 危险得多。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_SPECS, type ProjectRole } from "../identity/role.js";
import type { Capability } from "../harness/capability.js";

export interface LoadedPromptUnits {
  /** 按 promptUnits 声明顺序拼好的文本 */
  readonly text: string;
  /** 成功装载的单元 id */
  readonly loaded: readonly string[];
  /** **声明了但盘上没有**的单元 id —— 必须对用户可见 */
  readonly missing: readonly string[];
}

/** 单元 id → 文件名。id 里的点保留(与旧系统 communicator.decide.md 同一命名法)。 */
export function unitPath(dataDir: string, unitId: string): string {
  return join(dataDir, "harness", "system_prompts", `${unitId}.md`);
}

/**
 * 按声明顺序装载一个角色的全部提示词单元。
 *
 * 空白文件视为**未装载**(与旧系统 loadHarness 同一判据:空的 md 不该产生
 * 一个空段污染上下文)。
 */
export function loadPromptUnits(
  dataDir: string,
  unitIds: readonly string[],
): LoadedPromptUnits {
  const parts: string[] = [];
  const loaded: string[] = [];
  const missing: string[] = [];

  for (const id of unitIds) {
    const p = unitPath(dataDir, id);
    if (!existsSync(p)) {
      missing.push(id);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      missing.push(id);
      continue;
    }
    if (raw.trim() === "") {
      missing.push(id);
      continue;
    }
    parts.push(`<!-- ${id} -->\n${raw.trim()}`);
    loaded.push(id);
  }

  return { text: parts.join("\n\n"), loaded, missing };
}

// ── 角色简报(机械生成)────────────────────────────────────────

/** 能力的可读名。用于简报里列「你能做什么」。 */
const CAPABILITY_LABEL: Readonly<Partial<Record<Capability, string>>> = {
  "project.open": "立项",
  "project.read": "查看项目全貌",
  "project.update": "调整项目名/目标/状态",
  "project.close": "关闭项目(终态)",
  "work.create": "拆解出工作项并指定负责人",
  "work.update": "更新工作项状态",
  "work.assign": "改派工作项",
  "work.read": "查看工作项详情",
  "work.list": "列出工作项",
  "collab.ask": "向项目内其他角色提问",
  "collab.answer": "回答别人的提问",
  "collab.read": "查看等你的提问",
  "collab.convene": "发起对焦会议",
  "collab.meeting.read": "查看会议",
  "collab.meeting.respond": "在会议上表态",
  "collab.meeting.conclude": "收尾会议并出纪要",
  "collab.escalate": "把判不了的问题升级给上一级",
  "blackboard.read": "查看黑板上的工件",
  "blackboard.write": "往黑板写工件",
  "change.propose": "提出需求变更",
  "change.review": "评审需求变更",
  "change.read": "查看变更",
  "blocker.open": "登记阻塞",
  "blocker.update": "推进阻塞状态",
  "blocker.read": "查看阻塞",
  "memory.read": "检索长期记忆",
  "memory.write": "写入长期记忆",
  "knowledge.read": "检索项目语料(对话 / 工件正文)",
  "client.ask": "**向甲方提问**",
  "client.message": "**向甲方播报**",
  "code.read": "读代码",
  "code.write": "改代码",
  "code.exec": "执行命令",
  "work.report": "汇报进度",
};

/**
 * 角色中文名。**必须与 `runtime/org.ts` 的 `ORG` 逐项相同** —— 这一份曾经
 * 写成 `Worker(执行者)`(一个名字里塞进一句解释),而 `ORG` 写的是 `工程师`,
 * 于是同一个角色在提示词与界面上有两个名字(2026-10-08 收编)。
 * `tests/web/role-names.test.ts` 现在把这一份也纳入跨边界对照。
 */
const ROLE_NAME: Readonly<Record<ProjectRole, string>> = {
  business_manager: "业务经理",
  project_manager: "项目经理",
  research_worker: "研究员",
  coding_worker: "工程师",
  quality_reviewer: "质检审查员",
};

/**
 * 从 `ROLE_SPECS` 机械渲染角色简报。
 *
 * **不写创作性内容** —— 只把授权模型里已有的机器可读事实翻译成人话:
 * 我是什么角色、我能做什么、我**不能**做什么。
 *
 * 这份简报的价值在于**永远不会与授权模型脱节**:改 ROLE_SPECS,它自动跟着变。
 * 而「甲方只能找业务经理」这类边界,从此在提示词里和工具层是**同一份事实** ——
 * 这正是设计 1 §1 那个核心反转要解决的问题(约束写在提示词层而执行点在代码层)。
 */
export function renderRoleBrief(role: ProjectRole): string {
  const spec = ROLE_SPECS[role];
  const lines: string[] = [
    `# 你的角色:${ROLE_NAME[role]}`,
    "",
    spec.clientFacing
      ? "你是**唯一**对甲方接口的角色。别人遇到需要甲方拍板的事,都必须来找你转达。"
      : "你**不直接接触甲方**。需要甲方拍板的事,一律走升级链,由业务经理转达。",
    "",
    "## 你能做的事",
  ];

  const caps = spec.ceiling
    .map((c) => CAPABILITY_LABEL[c])
    .filter((l): l is string => l !== undefined);
  for (const l of caps) lines.push(`- ${l}`);

  lines.push("", "## 你**不能**做的事(工具层面就拿不到,不是靠自觉)");
  if (spec.boundaryDeny.length === 0) {
    lines.push("- (无显式限制)");
  } else {
    lines.push(`- 下列工具不在你的权限内:${spec.boundaryDeny.join(", ")}`);
  }

  lines.push(
    "",
    "## 边界是机制保证的",
    "以上不是「请你遵守」的约定 —— 超出权限的调用会在**工具层被拒绝**,并附带合法取值清单。",
    "所以:不要尝试绕过,也不要在被拒后反复重试同一个动作。改用你权限内的动词,或走上报。",
  );

  return lines.join("\n");
}

export interface ComposedPrompt {
  readonly text: string;
  readonly loadedUnits: readonly string[];
  readonly missingUnits: readonly string[];
}

/**
 * 拼出最终系统提示 = 角色简报 + 提示词单元。
 *
 * 简报在前:它定义**身份与边界**;单元在后:它们补充**具体工作方式**。
 */
export function composeSystemPrompt(
  dataDir: string,
  role: ProjectRole,
): ComposedPrompt {
  const units = loadPromptUnits(dataDir, ROLE_SPECS[role].promptUnits);
  const text = [renderRoleBrief(role), units.text].filter((s) => s.trim() !== "").join("\n\n");
  return { text, loadedUnits: units.loaded, missingUnits: units.missing };
}
