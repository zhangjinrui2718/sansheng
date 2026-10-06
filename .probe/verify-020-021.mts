/**
 * 真机验证 020 + 021 —— 跑在 `~/.sansheng/sansheng.db` 的 **VACUUM INTO 副本**上。
 *
 * 为什么不直接跑真库:这个探针要**写**(造一条提问 + 一条答复、造一条 fail 结论),
 * 而线上库里那个项目的甲方对话正在进行中。所以只读真库、写副本 ——
 * 与 `tests/platform/dispatcher-c3.test.ts` 里「真机库副本」那套做法同源。
 *
 * 它验四件事,每件都先自检判据本身(正样本 + 负样本,AGENTS.md「三类静默失败」③):
 *   ① 副本能打开 ⇒ 020 / 021 两笔迁移能落在**有存量数据**的库上
 *   ② 负样本:线上那个已答复的 W1 **不产生** todo(它没有台账行 —— 020 之前的提问)
 *   ③ 正样本:补一条台账行 + 答复 ⇒ `resume_client` 出现,且排第一
 *   ④ 负样本:清掉答复状态 ⇒ todo 消失(证明 ③ 不是恒真)
 *   ⑤ `review_verdict` 的 fail ⇒ W0 退回 in_progress + review_state=none
 */
import { existsSync, rmSync } from "node:fs";
import { openPlatformDb } from "../src/platform/storage/db.js";
import { collectTodos } from "../src/platform/runtime/dispatcher.js";
import { insertArtifact } from "../src/platform/storage/repo/artifacts.js";
import {
  recordClientQuestion, markClientQuestionAnswered, consumeClientAnswers,
} from "../src/platform/storage/repo/clientQuestions.js";
import { insertReviewVerdict } from "../src/platform/storage/repo/reviewVerdicts.js";
import { getWork, listWorksPendingReview } from "../src/platform/storage/repo/works.js";
import { resolveClientQuestion } from "../src/platform/tools/client.js";

const REAL_DB = `${process.env.HOME}/.sansheng/sansheng.db`;
const COPY = "/tmp/sansheng-020-021-probe.db";
const PID = "pj_muvyas8ym8eqn2vh"; // 美股项目

let fails = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
}

for (const f of [COPY, `${COPY}-wal`, `${COPY}-shm`]) if (existsSync(f)) rmSync(f);

// `VACUUM INTO` 要求**目标文件不存在**,所以先打开真库、从它 VACUUM 出来,
// 绝不能先 `openPlatformDb(COPY)`(那会把文件建出来)。
const src = openPlatformDb(REAL_DB);
src.exec(`VACUUM INTO '${COPY}'`);
src.close();
const c = openPlatformDb(COPY); // ← 这一步顺带把 020 / 021 落到有存量数据的库上

console.log("\n① 迁移落在有存量数据的真机库副本上");
for (const t of ["client_questions", "review_verdicts"]) {
  const row = c.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  check(`表 ${t} 存在`, row !== undefined);
}
const proj = c.prepare(`SELECT status FROM projects WHERE id=?`).get(PID) as { status: string } | undefined;
check("项目行还在(副本是完整的)", proj !== undefined, `status=${proj?.status}`);
const preAnswers = c
  .prepare(`SELECT COUNT(*) AS n FROM client_questions WHERE answered_at IS NOT NULL`)
  .get() as { n: number };
check("**负样本**:020 之前的提问没有台账行 ⇒ 它们不会被凭空当成待办", preAnswers.n === 0,
  `answered 台账行=${preAnswers.n}`);

console.log("\n② 负样本:线上那个已答复的 W1 不产生 todo");
const before = collectTodos({ db: c, projectId: PID, now: Date.now(), reportBatchSize: 1 });
check("没有 resume_client", before.runnable.every((t) => t.kind !== "resume_client"),
  `runnable=${before.runnable.map((t) => t.kind).join(",") || "(空)"}`);

console.log("\n③ 正样本:登记一次提问 + 甲方答复 ⇒ resume_client 出现且排第一");
const qid = "q_probe_020";
insertArtifact(c, {
  id: qid, projectId: PID, conversationId: null, kind: "client_question",
  status: "open", authorAgentId: "bm", title: "[探针] 探针提问", body: "[探针] 探针提问",
  metadataJson: null, createdAt: Date.now(), updatedAt: Date.now(), workId: null,
});
recordClientQuestion(c, { questionArtifactId: qid, projectId: PID, askedBy: "bm", askedAt: Date.now() });
let mid = 0;
const answered = collectTodos({ db: c, projectId: PID, now: Date.now(), reportBatchSize: 1 });
check("还没答复时**不**有 resume_client(球在甲方那边)",
  answered.runnable.every((t) => t.kind !== "resume_client"));

// 走**生产写口**:resolveClientQuestion 正是 HTTP 那个端点调的东西
resolveClientQuestion(c, qid, "[探针] 免费版", Date.now(), {
  newId: (p) => `${p}_probe_${++mid}`, answeredByAgentId: "bm",
});
const after = collectTodos({ db: c, projectId: PID, now: Date.now(), reportBatchSize: 1 });
const kinds = after.runnable.map((t) => t.kind);
check("答复后有 resume_client", kinds.includes("resume_client"), `runnable=${kinds.join(",") || "(空)"}`);
check("而且**排第一**(有人刚对你说话)", kinds[0] === "resume_client", `实际顺序=${kinds.join(",")}`);
const todo = after.runnable.find((t) => t.kind === "resume_client");
check("refs 指的就是那条提问", todo?.refs.join(",") === qid, `refs=${todo?.refs.join(",")}`);

console.log("\n④ 消费掉之后消失(终止判据是 consumed_at,不是预算)");
consumeClientAnswers(c, PID, "bm", Date.now());
const consumed = collectTodos({ db: c, projectId: PID, now: Date.now(), reportBatchSize: 1 });
check("消费后不再有", consumed.runnable.every((t) => t.kind !== "resume_client"));

console.log("\n⑤ 线上 W0 的真实形状 + fail 结论的后果");
const w0 = c.prepare(`SELECT id, status, review_state FROM works WHERE project_id=? AND parent_work_id IS NULL`).get(PID) as
  { id: string; status: string; review_state: string } | undefined;
check("根工作项存在", w0 !== undefined, `${w0?.id} status=${w0?.status} review=${w0?.review_state}`);
if (w0 !== undefined) {
  insertReviewVerdict(c, {
    workId: w0.id, projectId: PID, verdict: "fail", severity: "medium",
    findingArtifactId: null, note: "[探针] 模拟质检判不通过", reviewedBy: "qa", createdAt: Date.now(),
  });
  const { updateWorkStatus } = await import("../src/platform/storage/repo/works.js");
  const r = updateWorkStatus(c, w0.id, "in_progress", Date.now());
  check("fail ⇒ 能退回重做(迁移表【裁决 ①】)", r.ok, r.ok ? "" : r.message);
  const after2 = getWork(c, w0.id)!;
  check("W0 退回 in_progress", after2.status === "in_progress", `status=${after2.status}`);
  check("review_state 清成 none", after2.reviewState === "none", `review=${after2.reviewState}`);
  check("不再算「等审」", !listWorksPendingReview(c, PID).some((w) => w.id === w0.id));
}

c.close();
for (const f of [COPY, `${COPY}-wal`, `${COPY}-shm`]) if (existsSync(f)) rmSync(f);
console.log(`\n${fails === 0 ? "✅ 全部通过" : `❌ ${fails} 项没过`}\n`);
process.exit(fails === 0 ? 0 : 1);
