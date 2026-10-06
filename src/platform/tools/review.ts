/**
 * 质检的审查结论工具:`review_verdict`(能力 `work.review_verdict`)
 *
 * ── 为什么它必须是一个**工具**而不是一段约定 ──────────────────────
 *
 * 事故(2026-10-06 08:57):质检判**不通过**,审查意见落成工件,而工作项在库里是
 * `done` / `review_state='done'` —— 不会再审第二次,不通过也没有任何读者。
 * 根因是「审出了什么」只以**散文**存在于 `review_finding` 的正文里。
 *
 * 最省事的替代是让平台去 `review_finding.metadata_json` 里找 `{"verdict":"fail"}`。
 * **那不是替代,那是把同一个洞换个位置**:那是与模型约定的私有格式,模型这次
 * 照写、下次忘了写,表现是「静默地按通过处理」—— 与事故现场一模一样。
 * `markWorkReviewed` 原来的注释已经把这个反对写下来了(「判据不是『模型有没有
 * 写 review_finding』—— 那依赖模型自己建立 artifact_link」)。
 *
 * ⇒ 所以 verdict 由**一次工具调用**写入:调用它就是显式的、结构化的、无歧义的。
 * 调用**缺失**同样是可观测的(那条工作项留在 `review_state='pending'`,下一 tick
 * 重审并在告警里点名)—— 这与 `authorize.ts` 的 fail-closed 同一个方向。
 *
 * ── `fail` 的处置:重开原工作项,不开新工作项 ──────────────────────
 *
 * 走 `updateWorkStatus`(`works.status` 的**唯一**写口)迁到 `open`,于是
 * `review_state` 按迁移表自动清成 `none`,`execute_work` 规则下一次查库就会
 * 把它捡起来跑第二轮。**依赖树一个字不用动**(真机那个现场:W0 依赖的 7 个子项
 * 仍全是 done,前置本来就满足)。
 *
 * 为什么不「新建一条返工工作项」:
 *   - 新建要处理父子关系,而 AGENTS.md 记着真机上「9 work → 9 root → 0 中间」——
 *     按「是根」判会让扁平库里的每条真活失去执行者,新建极易变成孤儿根;
 *   - 重开保留 `work_id`,`artifacts.work_id` 那条产出边不断,质检下一轮还看得见
 *     上一轮的 finding(而 014 明确说那条边承载「产出」∪「关于」两个语义,
 *     **不许删**)。
 *
 * ⚠️ **尖角(有意的)**:一个改不好的工作项会「重开 → 再审 → 再 fail」循环,靠
 * `dispatch_attempts`(默认 3 次)兜住并广播停下。那是**有意的停**,不是静默停;
 * 用户会看到「同一件事试了 3 次」。想更精细就得记 `attempt_no` 并在第 N 次后
 * 要求质检升级为 `blocker.open` —— **故意先不做**:一次广播好过一条没人读的规则。
 */
import { Type } from "@sinclair/typebox";
import { getWork, updateWorkStatus } from "../storage/repo/works.js";
import { getArtifact } from "../storage/repo/artifacts.js";
import {
  insertReviewVerdict, isReviewSeverity, isReviewVerdict,
  type ReviewSeverity, type ReviewVerdict,
} from "../storage/repo/reviewVerdicts.js";
import {
  fail, ok, readString, requireProject, requireString, type PlatformTool, type ToolResult,
} from "./types.js";

const reviewVerdict: PlatformTool = {
  name: "review_verdict",
  capability: "work.review_verdict",
  description:
    "**你必须为每一次审查调用它** —— 写明这条产出是「通过」还是「不通过」。" +
    "「不通过」会让平台把这条工作项重开、由 worker 再做一轮;不调用它,平台**不会**" +
    "认为你审过了(它只认这个调用,不看你写的正文)。" +
    "审查意见本身仍然要落成 review_finding 工件 —— 结论给人看,这个调用给机器看。",
  parameters: Type.Object({
    workId: Type.String({ description: "你审的那条工作项" }),
    verdict: Type.Union(
      [Type.Literal("pass"), Type.Literal("fail")],
      { description: "pass=达成目标且依据可复核;fail=没达成(平台会重开它)" },
    ),
    severity: Type.Union(
      [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
      { description: "fail 时的严重程度。只给人看,平台不按它改变行为" },
    ),
    findingArtifactId: Type.Optional(Type.String({
      description: "对应的 review_finding 工件 id —— **强烈建议给**:它是这次结论的现场",
    })),
    note: Type.Optional(Type.String({ description: "一句话结论(给人看)" })),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "review_verdict");
    if (!proj.ok) return proj.result;
    const workId = requireString(args, "workId");
    if (!workId.ok) return workId.result;
    const verdictRaw = readString(args, "verdict");
    const severityRaw = readString(args, "severity");
    if (verdictRaw === undefined || !isReviewVerdict(verdictRaw)) {
      return fail("invalid_args", `verdict 只能是 pass 或 fail(收到「${String(verdictRaw)}」)`, [
        "pass", "fail",
      ]);
    }
    const verdict: ReviewVerdict = verdictRaw;
    if (!isReviewSeverity(severityRaw)) {
      return fail("invalid_args", `severity 只能是 low / medium / high(收到「${String(severityRaw)}」)`, [
        "low", "medium", "high",
      ]);
    }
    const severity: ReviewSeverity = severityRaw;

    // ── 先判(纯读)→ 一个字节都不写,除非全部成立 ──────────────
    const work = getWork(ctx.db, workId.value);
    if (work === null) return fail("not_found", `找不到工作项 ${workId.value}`);
    if (work.projectId !== proj.project.id) {
      // `denied` 而不是自造一个码:它就是 scope 门那件事(工作项在别的项目里),
      // 与授权层用同一个码,读日志的人不必区分「被授权门拦下」与「被工具自己发现」。
      return fail("denied", `工作项 ${workId.value} 不在当前项目里(它属于 ${work.projectId})`);
    }
    const findingId = readString(args, "findingArtifactId");
    if (findingId !== undefined) {
      const finding = getArtifact(ctx.db, findingId);
      if (finding === null) return fail("not_found", `找不到 review_finding 工件 ${findingId}`);
      if (finding.kind !== "review_finding") {
        return fail("invalid_args", `${findingId} 是 ${finding.kind},不是 review_finding`);
      }
    }

    const at = ctx.now();
    insertReviewVerdict(ctx.db, {
      workId: work.id, projectId: work.projectId, verdict, severity,
      findingArtifactId: findingId ?? null, note: readString(args, "note") ?? null,
      reviewedBy: ctx.agent.id, createdAt: at,
    });

    if (verdict === "pass") {
      // ⚠️ **这里不写 `review_state='done'`** —— 那是消费块的活(回合**成功结束**
      // 才写,与另外三支同纪律)。工具只负责「判据存在」,不负责「这一轮办过了」。
      return ok(
        `已记录审查结论:${work.title} = **通过**(severity=${severity})。` +
          `这条产出在本次审查回合成功结束后会标成已审。`,
      );
    }

    // ── fail:退回重做(走 works.status 的唯一写口)────────────────
    //
    // 目标态是 **`in_progress` 而不是 `open`**:`WORK_TRANSITIONS` 的【裁决 ①】
    // 已经把 `done → in_progress` 定为「审查后退回重做」的那条边,而
    // `done → open` **不存在**(从 `done` 出发只有 `in_progress` 一个出边)。
    // 裁决 ① 的第 3 条正好覆盖我们要的效果:迁出 `done` 时 `review_state` 清成
    // `none`,所以「等审」不会挂在一份已经退回重做的产出上 —— 它回 worker 了。
    //
    // 裁决 ① 里那条**已知代价**在这里原样成立:已经消费掉的 outbox 事件不会撤回,
    // 于是「已向甲方交代过完成」与「其实还没做完」可以同时成立。
    // **本次不修**(它需要一笔 `dispatch_events` 重建 + outbox 撤销语义,见裁决 ①
    // 的出路段),但这里**如实说给调用方听**,不静默。
    const r = updateWorkStatus(ctx.db, work.id, "in_progress", at);
    if (!r.ok) {
      // 落库失败要**响亮**:verdict 行已经写了,而工作项没能退回 ——
      // 那正是「不通过变成死信」的形态,必须让调用方知道。
      return fail(
        "conflict",
        `审查结论已落库(${verdict}),但退回重做失败:${r.message}。` +
          `**这条产出仍然处于「已审」状态** —— 需要人工处理`,
      );
    }
    return ok(
      `已记录审查结论:${work.title} = **不通过**(severity=${severity})。` +
        `工作项已退回 in_progress,worker 会再跑一轮。` +
        (findingId !== undefined ? `审查意见见 ${findingId}。` : "") +
        `\n⚠️ 若这次完成此前已向甲方交代过,那次交代**不会**被撤回(迁移表【裁决 ①】` +
        `记着的已知代价)—— 需要时请主动向甲方说明。`,
    );
  },
};

export const REVIEW_TOOLS: readonly PlatformTool[] = [reviewVerdict];
