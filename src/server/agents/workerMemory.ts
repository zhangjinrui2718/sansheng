/**
 * Sansheng · 给「干活的人」的记忆块(批次 8-D / 审计 M3)
 *
 * 问题的来历:记忆功能一直只在**沟通员**那条路上生效(ws.ts 的 `send` 路径),
 * planner / executor 走 `makeLlmCall` 时是**零记忆**的 —— 用户说过「回答用中文」
 * 「别动我的项目目录」,规划与执行全都看不见。
 * 结果是「它记得」与「它照着做」之间断了一节:最该用到偏好的恰恰是干活的那两个。
 *
 * 这个模块把两件事从 ws.ts 里拎出来,是为了**可测**:
 *   · `buildWorkerMemoryBlock` —— 检索 + 拼装(与沟通员 chat 路径同源同参);
 *   · `composeWithMemory` —— 决定记忆块怎么进 userPrompt。
 * 两者都是纯函数式的,测试直接跑生产实现,不是「测一个长得像的复制品」。
 *
 * 失败语义:**检索/拼装抛错一律降级为「不注入」** —— 记忆是增强,不是前置条件,
 * 记忆库坏了不该让整条 plan 失败。
 */
import type { Storage } from "../storage/index.js";
import { listProfile, searchFragmentsByText } from "../storage/index.js";

/** 检索条数上限。3 条:够覆盖「身份 + 偏好 + 项目」,又不会把 userPrompt 撑成小册子。 */
export const WORKER_MEMORY_LIMIT = 3;

/**
 * 把 user message 包成含历史上下文的记忆块(与 ws.ts 的 buildContextBlock 同一份实现)。
 * 抽取到本模块是为了让 chat 路径与 worker 路径**共用同一份格式** ——
 * 两处各写一份的必然结局是「沟通员看到的记忆格式」与「执行者看到的」不一样。
 */
export function buildContextBlock(
  fragments: Array<{ kind: string; content: string }>,
  profile: Array<{ key: string; value: string; confidence?: number }>,
): string {
  if (fragments.length === 0 && profile.length === 0) return "";
  const parts: string[] = [];
  if (profile.length > 0) {
    parts.push("# User Profile");
    for (const p of profile) {
      parts.push(
        `- ${p.key}: ${p.value}${p.confidence !== undefined ? ` (confidence: ${p.confidence.toFixed(2)})` : ""}`,
      );
    }
  }
  if (fragments.length > 0) {
    parts.push("\n# Relevant Memories");
    for (const f of fragments) {
      parts.push(`- [${f.kind}] ${f.content}`);
    }
  }
  return parts.join("\n");
}

/**
 * 按当前这条任务描述检索记忆并拼块。**不抛** —— 调用方拿 undefined 就当没有记忆。
 */
export function buildWorkerMemoryBlock(
  storage: Storage,
  userPrompt: string,
): string | undefined {
  try {
    const fragments = searchFragmentsByText(storage.db, userPrompt, {
      limit: WORKER_MEMORY_LIMIT,
    });
    const profile = listProfile(storage.db);
    const block = buildContextBlock(
      fragments.map((f) => ({ kind: f.kind, content: f.content })),
      profile.map((p) => ({ key: p.key, value: p.value, confidence: p.confidence })),
    );
    return block || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 记忆块拼在 userPrompt **前面**,中间用一条 `---` 分隔。
 *
 * 为什么放前面而不是后面:planner / executor 的输出协议在 systemPrompt 里,
 * 任务描述在后面 —— 记忆放前面,离协议说明更近,被当成「背景资料」而不是「任务要求」
 * 的概率更高(模型对 prompt 末尾的内容更敏感,这也是为什么任务本身要放末尾)。
 *
 * block 为空 → **原样返回**,一个字都不加(不给「# 记忆(空)」这种噪音段)。
 */
export function composeWithMemory(userPrompt: string, block: string | undefined): string {
  if (!block) return userPrompt;
  return `${block}\n\n---\n${userPrompt}`;
}