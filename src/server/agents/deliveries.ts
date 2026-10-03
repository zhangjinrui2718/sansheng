/**
 * Sansheng · 交付物挑选(pickDeliveries)· 批次 7-I(B)
 *
 * **这个模块要解决的缺陷(B)**:plan 跑完之后,executor 写出的 evidence 正文
 * —— 可能是一份几千字的技术方案 —— 只躺在 blackboard 里。用户收到的是一行
 * `计划 "X" 完成 3/5`,真正的产物要自己去「工件」tab 翻。
 *
 * **这不是「少传数据」**:`plan_done` 事件早���就把整个 `artifacts` 带过来了
 * (ws.ts 的 `artifacts: finalBb.artifacts ?? []`),是前端把它丢了、只渲染
 * `summary`。协议上早就有路,缺的是**挑出交付物并让人看见**。
 *
 * ── 挑选规则:只收 resolved 的 evidence ─────────────────────────────────
 * 逐类排除的理由(每一条都是刻意的,不是「顺手只取一种」):
 *
 *   evidence / resolved  →  **交付物本体**。执行者确实做出来了的东西。
 *   hypothesis            →  **不算交付**。它意味着「卡住了,等用户拍板」,
 *                           该走的是升级提问通道(pendingQuestions / escalation),
 *                           混进「交付」会让用户以为事情做完了。
 *   note                  →  **不算交付**。这是失败说明,是错误不是产物。
 *   todo                  →  本身不是产物,是工单;它的正文在 evidence 里。
 *   intent                →  目标是输入不是输出。
 *   decision              →  是「用户/沟通员的决定」,属于交互记录,不是执行者产出。
 *
 * 一句话:**交付物 = 执行者真正做出来、且已经完成的东西。** 其余一切都在别处
 * 有自己的呈现方式,不该在这里稀释交付语义。
 */
import type { BlackboardArtifact } from "../../../shared/types/blackboard.js";
import type { DeliveryItem } from "../../../shared/types/chat.js";

/**
 * 单个工件的正文长度上限(字符)。
 *
 * 为什么要截:一次 plan 可能产出十几条 evidence,全量塞进一个 WS 事件会让
 * 聊天页首屏渲染几千字 —— 而用户通常只关心主交付物。这里取 12000 字符:
 * 足够装一份完整的中文技术方案(约 6-8k token),又不会让一个事件膨胀到
 * 十几 MB。**被截断的条目会在正文末尾显式标注**,不静默丢内容。
 */
export const DELIVERY_BODY_MAX_CHARS = 12_000;

const TRUNCATION_NOTE = `\n\n> ⚠️ 交付正文超过 ${DELIVERY_BODY_MAX_CHARS} 字符,此处已截断。完整内容见「工件」页的同名条目。`;

function clampBody(body: string): { text: string; truncated: boolean } {
  if (body.length <= DELIVERY_BODY_MAX_CHARS) return { text: body, truncated: false };
  return { text: body.slice(0, DELIVERY_BODY_MAX_CHARS) + TRUNCATION_NOTE, truncated: true };
}

/**
 * 从 blackboard 快照里挑出交付物。
 *
 * @param artifacts `BlackboardShape.artifacts`(整块 blackboard)
 * @returns resolved 的 evidence,按稳定顺序(见下);无则空数组
 *
 * 排序:**先按创建时间,同刻按 id**。工件 id 含 `nanoid`,同毫秒内创建的顺序
 * 不可依赖;用 id 兜底保证同一份输入永远得到同一个输出 —— 否则测试会在
 * 「并发创建两条 evidence」时偶发失败,且现场极难复现。
 */
export function pickDeliveries(artifacts: readonly BlackboardArtifact[]): DeliveryItem[] {
  const picked = artifacts
    .filter((a) => a.kind === "evidence" && a.status === "resolved")
    .slice()
    .sort((a, b) => {
      const byTime = (a.createdAt ?? 0) - (b.createdAt ?? 0);
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });

  return picked.map((a) => {
    const { text } = clampBody(a.body ?? "");
    const parentTodoId = a.metadata?.["parentTodoId"];
    const todoTitle =
      typeof parentTodoId === "string" && parentTodoId.length > 0
        ? artifacts.find((x) => x.id === parentTodoId)?.title
        : undefined;
    return {
      id: a.id,
      kind: a.kind,
      title: a.title,
      body: text,
      ...(todoTitle !== undefined ? { todoTitle } : {}),
    };
  });
}
