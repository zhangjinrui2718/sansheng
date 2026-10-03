/**
 * BC7 Memory · 端口
 *
 * ── 为什么是端口而不是直接调存储 ──────────────────────────────────
 *
 * 设计 1 §8.3 的决策:「记忆系统先简单做,预留接口,将来能接第三方记忆系统。」
 *
 * 上层(工具、agent 运行时)只依赖这个接口,**不依赖任何具体存储**。于是
 * 「换记忆后端」= 换一个 `MemoryPort` 实现,agent 代码一行不动。第三方
 * (向量库 / 托管记忆服务 / 知识图谱)只要能包出这三个方法就能接。
 *
 * ── 记忆是「用户」的,不是任何 agent 的 ────────────────────────────
 *
 * 四个角色共享同一个用户,也就共享同一份记忆。它记的是:用户是谁、偏好什么、
 * 项目背景是什么。这跟 agent 的「上下文」不是一回事 —— 上下文随回合消失,
 * 记忆跨回合、跨项目存在。
 *
 * ── 本轮实现的范围(明确不做的事)────────────────────────────────
 *
 * 做:文本检索(bigram 匹配)+ 去重 + 访问计数
 * 不做:向量检索(旧系统对它零读取却持续付费)、衰减调度、跨项目融合
 *
 * `decay()` 是**可选方法** —— 本轮实现是 no-op,但接口留着,这样将来接一个
 * 支持衰减的后端不需要改调用方。
 */

/** 记忆的分类闭合集。与工件 kind 是两套词汇,不要混。 */
export type FragmentKind = "fact" | "preference" | "project" | "context" | "summary";

export const FRAGMENT_KINDS: readonly FragmentKind[] = [
  "fact",
  "preference",
  "project",
  "context",
  "summary",
];

export function isFragmentKind(v: unknown): v is FragmentKind {
  return typeof v === "string" && (FRAGMENT_KINDS as readonly string[]).includes(v);
}

export interface Fragment {
  id: string;
  kind: FragmentKind;
  content: string;
  importance: number;
  decayFactor: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  sourceProjectId: string | null;
}

export interface RememberInput {
  content: string;
  kind: FragmentKind;
  importance?: number;
  sourceProjectId?: string;
}

export interface RecallOptions {
  limit?: number;
  kinds?: readonly FragmentKind[];
}

/**
 * 记忆后端契约。**这是 BC7 的唯一对外接口。**
 *
 * 三个方法都用 Promise —— 即便当前实现是同步的 SQLite。因为这一层存在的
 * 全部意义就是「将来换成可能需要 IO 的第三方」,异步签名让那次替换不需要
 * 改任何调用方。
 */
export interface MemoryPort {
  /** 写入一条记忆。内容重复时返回已有那条的 id(不重复入库)。 */
  remember(input: RememberInput): Promise<string>;

  /** 按文本检索。返回按相关度排序的片段。 */
  recall(query: string, opts?: RecallOptions): Promise<Fragment[]>;

  /**
   * 衰减维护。**可选** —— 不支持的后端可以不实现,调用方必须容忍缺席。
   * 当前 SQLite 实现是 no-op(本轮不做衰减调度)。
   */
  decay?(): Promise<void>;
}
