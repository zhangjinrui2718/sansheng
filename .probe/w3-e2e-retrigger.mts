/**
 * W3-③ 端到端 · **第 3 步(arm B):换一个不泄露答案的目标 + 再放一条 outbox 事件**
 *
 * ── 为什么要换目标(arm A 暴露出来的一个夹具缺陷)────────────────
 *
 * arm A 的目标文本里写着「验证平台叫醒业务经理的回合会留下工作记录([未播报])」——
 * 那句话**把答案写进了 prompt**。真模型的反应也很直白:它读到了目标里的 `[未播报]`,
 * 明确说「项目目标里明确标注 **[未播报]**」,然后**照样没有写那一行**
 * (因为当时数据目录里的提示词是**旧的**,压根没有这条规矩)。
 *
 * 这对 arm A 的结论是**加强**而不是削弱:连「目标里点名了」都压不出那一行,
 * 说明那一行当时**只能**来自提示词。但作为 arm B 的对照,目标必须换成中性的 ——
 * 否则「它写了」会被归因到目标文本上,而不是提示词。
 *
 * ── 为什么还要再放一条事件 ──────────────────────────────────────
 *
 * arm A 那一回合成功结束之后,`dispatch_events` 里那条未消费行被平台标记成
 * 「已交代」(`consumePendingDispatchEvents`)⇒ 待办消失。要看第二个回合,就得有
 * 第二个真实触发:`report_downstream` 的 `key` 带事件版本号(`seq`),所以新事件
 * 会自动拿到新的待办键与新的尝试预算,不需要清理账本。
 *
 * 用法:`npx tsx .probe/w3-e2e-retrigger.mts <dataDir> <projectId> <workId>`
 */
import { join } from "node:path";
import { openPlatformDb } from "../src/platform/storage/db.js";
import { updateProject } from "../src/platform/storage/repo/projects.js";
import { insertDispatchEvent } from "../src/platform/storage/repo/dispatch.js";
import { collectTodos } from "../src/platform/runtime/dispatcher.js";

const [dataDir, projectId, workId] = process.argv.slice(2);
if (dataDir === undefined || projectId === undefined || workId === undefined) {
  console.error("用法:npx tsx .probe/w3-e2e-retrigger.mts <dataDir> <projectId> <workId>");
  process.exit(2);
}

const NOW = Date.now();
const db = openPlatformDb(join(dataDir, "sansheng.db"));

// 中性目标:一个字都不提 [未播报]、不提「工作记录」——
// 这样 arm B 里那一行如果出现,来源只可能是 business_manager.core 的硬要求。
updateProject(db, projectId, {
  goal: "把登录做出来:能登录、能登出、会话 30 分钟过期。验收判据:三条路径各有一次可复现的验证记录。",
});
console.log("[retrigger] 目标已换成中性文本(不含 [未播报] / 工作记录 字样)");

const ev = insertDispatchEvent(db, {
  projectId,
  kind: "work_failed",
  subjectId: workId,
  summary: "arm B 夹具:又一条下游工作项失败(触发第二次汇报待办)",
  createdAt: NOW,
});
if (!ev.written) throw new Error(`insertDispatchEvent 未写入:${ev.reason} —— ${ev.detail ?? ""}`);
console.log("[retrigger] 新 dispatch_event 已写(work_failed)");

// 自检:这一次也必须是**恰好**一条 report_downstream
const board = collectTodos({ db, projectId, now: NOW });
const kinds = board.runnable.map((t) => `${t.role}:${t.kind}`);
console.log(`[retrigger] collectTodos ⇒ runnable=[${kinds.join(", ")}] exhausted=[${board.exhausted.length}]`);
if (!(board.runnable.length === 1 && board.runnable[0]!.kind === "report_downstream")) {
  console.error(`[retrigger] ✗ 期待恰好一条 report_downstream,实际 [${kinds.join(", ")}]`);
  db.close();
  process.exit(1);
}
console.log(`[retrigger] ✓ ${board.runnable[0]!.label}`);
db.close();
