/**
 * Sansheng · 平台协议的**共享词表**(中文读法 + 语义色)
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 *
 * 契约里所有状态都是闭合联合(`platform.ts` 头部的「领域闭集」),但**中文读法**
 * 不在契约里。旧前端把同一张表在四个页面各抄一遍,结果同一个状态在两页写成
 * 两种说法(Goals 的 `open` = 进行中,Artifacts 的 `open` = 待处理)。现在只有这一份。
 *
 * ── 纪律 ────────────────────────────────────────────────────────
 *
 *   1. **key 必须与契约的联合逐个对齐**;缺一个,页面上就会出现英文原文
 *      (`statusLabel` 的兜底是原样透出,不猜含义)。
 *   2. 未知取值**不猜**:一律原样显示 —— 「显示英文」比「显示一个编的中文」诚实。
 *   3. 不新增契约里没有的取值。要加状态 = 先改 `shared/types/platform.ts`
 *      (那是后端与契约的事,前端只消费)。
 */
import type {
  ArtifactKind,
  ArtifactStatus,
  AskStatus,
  BlockerSeverity,
  BlockerStatus,
  ChangeStatus,
  ProjectRole,
  ProjectStatus,
  WorkStatus,
} from "@shared/types/platform";
import type { Tone } from "@/components/ui/primitives";

// ── 项目 ────────────────────────────────────────────────────────

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "立项中",
  active: "进行中",
  paused: "已暂停",
  done: "已交付",
  abandoned: "已放弃",
};

export const PROJECT_STATUS_TONE: Record<ProjectStatus, Tone> = {
  draft: "mute",
  active: "jade",
  paused: "amber",
  done: "bamboo",
  abandoned: "cinnabar",
};

// ── 工作项 ──────────────────────────────────────────────────────

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  open: "待接手",
  in_progress: "进行中",
  blocked: "被卡住",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const WORK_STATUS_TONE: Record<WorkStatus, Tone> = {
  open: "mute",
  in_progress: "jade",
  blocked: "cinnabar",
  done: "bamboo",
  failed: "cinnabar",
  cancelled: "mute",
};

/** 「还活着」= 还没进终态。工作项列表的默认排序用它。 */
export const WORK_ALIVE: ReadonlySet<WorkStatus> = new Set<WorkStatus>([
  "open",
  "in_progress",
  "blocked",
]);

// ── 工件 ────────────────────────────────────────────────────────

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  decision: "决策",
  note: "笔记",
  evidence: "证据",
  hypothesis: "假设",
  project_brief: "项目简报",
  work_brief: "工作简报",
  meeting_note: "会议记录",
  review_finding: "评审发现",
  change_record: "变更记录",
  client_question: "甲方提问",
  // 「交付物」有四个所指(设计 1 §2.11.5):这里专指 deliverable **工件** ——
  // 不是 worker 产出、不是根工作项、也不是 projects.status='done'(那个读作「已交付」)。
  deliverable: "交付物",
};

export const ARTIFACT_KIND_TONE: Record<ArtifactKind, Tone> = {
  decision: "bamboo",
  note: "bone",
  evidence: "bone",
  hypothesis: "amber",
  project_brief: "jade",
  work_brief: "jade",
  meeting_note: "cyan",
  review_finding: "ochre",
  change_record: "ochre",
  client_question: "amber",
  deliverable: "bamboo",
};

export const ARTIFACT_STATUS_LABEL: Record<ArtifactStatus, string> = {
  open: "有效",
  accepted: "已采纳",
  rejected: "已否决",
  superseded: "被取代",
};

export const ARTIFACT_STATUS_TONE: Record<ArtifactStatus, Tone> = {
  open: "jade",
  accepted: "bamboo",
  rejected: "cinnabar",
  superseded: "mute",
};

// ── 提问 / 阻塞 / 变更 ──────────────────────────────────────────

export const ASK_STATUS_LABEL: Record<AskStatus, string> = {
  open: "等回答",
  answered: "已回答",
  escalated: "已升级",
  cancelled: "已取消",
  expired: "已超时",
};

/**
 * AskStatus → 语义色。
 *
 * `escalated` 是**琥珀不是红**:它表示「有人替你判断过、认为这事得往上走」,
 * 不是失败;`expired` 才是红 —— 过了截止还没人答,那是真的没人管。
 * (调度器只如实报超时,不自动升级,见契约 `overdue_asks`。)
 */
export const ASK_STATUS_TONE: Record<AskStatus, Tone> = {
  open: "bone",
  answered: "bamboo",
  escalated: "amber",
  cancelled: "mute",
  expired: "cinnabar",
};

export const BLOCKER_STATUS_LABEL: Record<BlockerStatus, string> = {
  open: "未处理",
  acknowledged: "已知悉",
  resolved: "已解决",
  deferred: "已搁置",
  rejected: "已驳回",
};

export const BLOCKER_STATUS_TONE: Record<BlockerStatus, Tone> = {
  open: "cinnabar",
  acknowledged: "amber",
  resolved: "bamboo",
  deferred: "mute",
  rejected: "mute",
};

export const BLOCKER_SEVERITY_LABEL: Record<BlockerSeverity, string> = {
  low: "轻",
  medium: "中",
  high: "重",
  critical: "致命",
};

export const BLOCKER_SEVERITY_TONE: Record<BlockerSeverity, Tone> = {
  low: "mute",
  medium: "amber",
  high: "ochre",
  critical: "cinnabar",
};

export const CHANGE_STATUS_LABEL: Record<ChangeStatus, string> = {
  proposed: "已提议",
  under_review: "评审中",
  accepted: "已接受",
  implemented: "已实施",
  rejected: "已否决",
};

export const CHANGE_STATUS_TONE: Record<ChangeStatus, Tone> = {
  proposed: "amber",
  under_review: "cyan",
  accepted: "jade",
  implemented: "bamboo",
  rejected: "cinnabar",
};

// ── 角色 ────────────────────────────────────────────────────────

/**
 * 四角色中文名。**兜底表** —— 后端在 `MemberView` / `RoleHarnessView` 里都给了
 * `displayName`,页面优先用那个;这里只在字段缺失时用。
 *
 * ⚠️ **这四个词必须与 `src/platform/runtime/org.ts` 的 `ORG` 逐项相同**(2026-10-06)。
 * 在此之前这里写的是「执行者 / 质检审查员」,而 harness 页写的是
 * 「Worker(执行者)」、成员页读库里的「工程师 / 质检」—— 同一个角色三个名字,
 * 而且其中一个名字里塞着解释。`tests/web/role-names.test.ts` 是一条**跨边界对照**:
 * 这两张表之间再加一层漂移就会红。
 */
export const ROLE_LABEL: Record<ProjectRole, string> = {
  business_manager: "业务经理",
  project_manager: "项目经理",
  worker: "工程师",
  quality_reviewer: "质检",
};

// ── 读取器(未知值原样透出,绝不猜)────────────────────────────

export const projectStatusLabel = (s: string): string =>
  (PROJECT_STATUS_LABEL as Record<string, string>)[s] ?? s;
export const projectStatusTone = (s: string): Tone =>
  (PROJECT_STATUS_TONE as Record<string, Tone>)[s] ?? "mute";
export const workStatusLabel = (s: string): string =>
  (WORK_STATUS_LABEL as Record<string, string>)[s] ?? s;
export const workStatusTone = (s: string): Tone =>
  (WORK_STATUS_TONE as Record<string, Tone>)[s] ?? "mute";
export const artifactKindLabel = (k: string): string =>
  (ARTIFACT_KIND_LABEL as Record<string, string>)[k] ?? k;
export const artifactKindTone = (k: string): Tone =>
  (ARTIFACT_KIND_TONE as Record<string, Tone>)[k] ?? "bone";
export const artifactStatusLabel = (s: string): string =>
  (ARTIFACT_STATUS_LABEL as Record<string, string>)[s] ?? s;
export const artifactStatusTone = (s: string): Tone =>
  (ARTIFACT_STATUS_TONE as Record<string, Tone>)[s] ?? "mute";
export const askStatusLabel = (s: string): string =>
  (ASK_STATUS_LABEL as Record<string, string>)[s] ?? s;
export const askStatusTone = (s: string): Tone =>
  (ASK_STATUS_TONE as Record<string, Tone>)[s] ?? "mute";
export const blockerStatusLabel = (s: string): string =>
  (BLOCKER_STATUS_LABEL as Record<string, string>)[s] ?? s;
export const blockerStatusTone = (s: string): Tone =>
  (BLOCKER_STATUS_TONE as Record<string, Tone>)[s] ?? "mute";
export const blockerSeverityLabel = (s: string): string =>
  (BLOCKER_SEVERITY_LABEL as Record<string, string>)[s] ?? s;
export const blockerSeverityTone = (s: string): Tone =>
  (BLOCKER_SEVERITY_TONE as Record<string, Tone>)[s] ?? "mute";
export const changeStatusLabel = (s: string): string =>
  (CHANGE_STATUS_LABEL as Record<string, string>)[s] ?? s;
export const changeStatusTone = (s: string): Tone =>
  (CHANGE_STATUS_TONE as Record<string, Tone>)[s] ?? "mute";

// ── 展示工具 ────────────────────────────────────────────────────

/** `toLocaleString()` 的短格式:带日期,秒级精度不需要。 */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 折成单行并截断 —— 用于卡片摘要行,避免长 body 撑破布局。 */
export function excerpt(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
