/**
 * 平台通知 —— `session_messages` 里 `kind === "system"` 那几行的**唯一**一处分类。
 *
 * ── 这些行是什么(写面只有两处,都是平台自己)──────────────────────
 *
 *   - `src/platform/host/serve.ts` 的 `announceDrain` —— 排空器异常停下
 *     (`max_rounds` / 预算用尽)。项目级事实:组织不动了、为什么、路径是谁。
 *   - 同文件的 `reportUnannouncedTurn` —— 平台叫醒的回合没留工作记录。
 *     回合级事实:哪个角色、哪条待办类别、正文前 120 字。
 *
 * 两处都用 `ensureSession(…, "internal")` 落进项目的**内部会话**,`agent_id` 为
 * `NULL`(作者是平台,不是任何角色)。它们不是「甲方说的话」,也不是任何一个角色的
 * 发言 —— 前端 `channelOf` 第 1 步就按 `role === "system"` 把它们摘进独立的系统带。
 *
 * ── 为什么这里只做「分类」,不把字段解析出来 ────────────────────────
 *
 * 那些正文是平台拼的字符串,库里没有结构列。按中文前缀把回合数 / 路径 / 待办类别
 * **抽成字段**看着更整齐,但它的失败方式是静默的:动词改一个字,字段变 `null`,
 * 页面上出现一张空壳卡而没有任何报错(AGENTS.md 三类静默失败的同款)。
 * 所以这里只回答一个问题 —— **这是哪一类通知** —— **正文原样交给渲染层**:
 * 分类失手最多退化成「平台通知」,一个字都不会丢;而「丢了正文」正是 7-N 要防的。
 *
 * 两个读者:
 *   - 项目页的「组织运行态」卡 —— **全文的落点**(这些记录的主体是项目,不是某条对话);
 *   - 对话页的系统带 —— 只借 `platformNoticeLabel` 生成一行摘要,正文默认折叠。
 */
import type { SessionMessageView } from "@shared/types/platform";

/** 三类:**停止推进**(项目级)/ **合规告警**(回合级)/ 其余平台通知。 */
export type PlatformNoticeKind = "stop" | "compliance" | "other";

/**
 * 分类前缀。它们与 `serve.ts` 两处写入侧的正文首段**逐字同形**。
 *
 * ⚠️ 判据是 `startsWith` 在**正文首行**上,不是 `includes` —— 一条正文中段引用了
 * 这些字样的记录不该被改判(与 `[未播报]` 的行首判据同一条纪律)。
 */
const STOP_PREFIX = "⚠️ 组织停止推进";
const COMPLIANCE_PREFIX = "⚠️ 平台检测";

/** 一条通知:正文**原样**带着,不解析、不截断。 */
export interface PlatformNotice {
  readonly id: string;
  readonly kind: PlatformNoticeKind;
  /** 库里那一段原文(含 `⚠️` 开头与换行) */
  readonly content: string;
  readonly createdAt: number;
}

export interface PlatformNotices {
  /** 全部通知,**新的在前** */
  readonly all: readonly PlatformNotice[];
  /** 停止推进(项目级)—— 项目页先显示这一组:它影响时间表 */
  readonly stops: readonly PlatformNotice[];
  /** 合规告警(回合级)—— 「判断过」与「漏了」的分界 */
  readonly compliance: readonly PlatformNotice[];
  readonly total: number;
}

/**
 * 一条 `system` 正文属于哪一类。
 *
 * ⚠️ 只看**首行**:`⚠️` 出现 `\uFE0F`(变体选择符),两处写入侧的正文都以它开头,
 * 所以判据写成对首行的前缀比较,而不是对整个字符串的 `includes`。
 */
export function classifyPlatformNotice(content: string): PlatformNoticeKind {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const head = firstLine.trimStart();
  if (head.startsWith(STOP_PREFIX)) return "stop";
  if (head.startsWith(COMPLIANCE_PREFIX)) return "compliance";
  return "other";
}

/**
 * 人读的类名。**不带 emoji 与括号解释** —— 与角色名同一条 UI 纪律
 * (`web/src/lib/vocab.ts` / `runtime/org.ts` 那张唯一的角色名表同一个理由:
 * 同一个东西在不同页面上有两个名字,读者会以为是两件事)。
 */
export function platformNoticeLabel(kind: PlatformNoticeKind): string {
  switch (kind) {
    case "stop":
      return "停止推进";
    case "compliance":
      return "合规告警";
    case "other":
      return "平台通知";
  }
}

/**
 * 从会话消息里挑出平台通知。
 *
 * 输入就是 `GET /api/projects/:id/messages` 那条端点交出来的行 —— 它已经把项目里
 * **所有会话**(内部会话 + 交付会话)的消息按时间归并好了,所以这里不需要再多一条
 * 端点,也不需要迁移:`kind` 那一位本来就是契约字段。
 *
 * 只认 `kind === "system"`:同一条正文如果出现在助手消息里,那是一个角色在**谈论**
 * 这件事,不是平台在报这件事(负样本见 `tests/web/platform-notices.test.ts`)。
 */
export function collectPlatformNotices(
  messages: readonly Pick<SessionMessageView, "id" | "kind" | "content" | "createdAt">[],
): PlatformNotices {
  const all: PlatformNotice[] = [];
  for (const m of messages) {
    if (m.kind !== "system") continue;
    all.push({
      id: m.id,
      kind: classifyPlatformNotice(m.content),
      content: m.content,
      createdAt: m.createdAt,
    });
  }
  // 新的在前:页面上先看到「刚才那一次为什么停」,历史往下排。
  all.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return {
    all,
    stops: all.filter((n) => n.kind === "stop"),
    compliance: all.filter((n) => n.kind === "compliance"),
    total: all.length,
  };
}
