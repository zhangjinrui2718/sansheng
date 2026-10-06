/**
 * 真机验证:工件关系图跑在 **`~/.sansheng/sansheng.db` 上,全程只读**。
 *
 * 它回答一个单元测试回答不了的问题:这张图在**真机那份库**上是什么形状 ——
 * 几列几个点、哪一类边有几条、哪些是孤点。
 * 单元测试的夹具是我照着真库编的,而「照着编」这件事本身就会把真实形状里的
 * 意外一起编掉(AGENTS.md「拿一个已知答案的样本自检」)。
 *
 * **只读**:用 better-sqlite3 的 `{ readonly: true }` 打开,一条 INSERT 都没有
 * (第一版写的 `file:...?mode=ro` 在 better-sqlite3 上打不开 —— 它不解析 URI 前缀)。
 * 2026-10-06 第一版把它写成「把真库整份灌进内存库」,那既是多余的搬运,
 * 又在注释里写着「只读」却做了一整轮写 —— 那种自相矛盾比慢更糟。
 */
import Database from "better-sqlite3";
import { layoutArtifactGraph, RELATIONS, type ArtifactRelation } from "../web/src/lib/artifactGraph.js";
import type { ArtifactView, WorkView } from "../shared/types/platform.js";

const REAL_DB = `${process.env.HOME}/.sansheng/sansheng.db`;
const PID = "pj_muvyas8ym8qn2vh"; // 不存在的项目 ⇒ 顺带自检「读不到」时如实报空
const TARGET = "pj_muvyas8ym8eqn2vh"; // 美股项目

const db = new Database(REAL_DB, { readonly: true });
try {
  const proj = db.prepare(`SELECT name FROM projects WHERE id=?`).get(TARGET) as
    | { name: string } | undefined;
  if (proj === undefined) throw new Error(`找不到项目 ${TARGET}`);

  const works = db
    .prepare(`SELECT * FROM works WHERE project_id=? ORDER BY created_at`)
    .all(TARGET) as Array<Record<string, unknown>>;
  const arts = db
    .prepare(`SELECT * FROM artifacts WHERE project_id=? ORDER BY created_at`)
    .all(TARGET) as Array<Record<string, unknown>>;
  const links = db
    .prepare(
      `SELECT l.artifact_id AS fromId, l.rel, l.target_artifact_id AS toId
       FROM artifact_links l JOIN artifacts a ON a.id = l.artifact_id
       WHERE a.project_id = ?`,
    )
    .all(TARGET) as Array<{ fromId: string; rel: string; toId: string }>;
  const byId = new Map<string, Array<{ rel: string; targetId: string }>>();
  for (const l of links) {
    byId.set(l.fromId, [...(byId.get(l.fromId) ?? []), { rel: l.rel, targetId: l.toId }]);
  }

  const workViews: WorkView[] = works.map((w) => ({
    id: w.id as string, projectId: w.project_id as string,
    parentWorkId: (w.parent_work_id as string | null) ?? null,
    title: w.title as string, goal: w.goal as string,
    status: w.status as WorkView["status"],
    assigneeAgentId: w.assignee_agent_id as string,
    assigneeName: w.assignee_agent_id as string,
    createdAt: w.created_at as number, updatedAt: w.updated_at as number,
    dependsOn: [],
  }));
  const views: ArtifactView[] = arts.map((a) => ({
    id: a.id as string, projectId: a.project_id as string,
    kind: a.kind as ArtifactView["kind"], status: a.status as ArtifactView["status"],
    title: a.title as string, body: "",
    authorAgentId: a.author_agent_id as string, authorName: a.author_agent_id as string,
    createdAt: a.created_at as number, updatedAt: a.updated_at as number,
    links: (byId.get(a.id as string) ?? []).map((l) => ({
      rel: l.rel as ArtifactView["links"][number]["rel"], targetId: l.targetId,
    })),
    workId: (a.work_id as string | null) ?? null,
  }));

  const layout = layoutArtifactGraph(views, workViews);
  const t = (id: string): string => views.find((v) => v.id === id)?.title ?? id;

  console.log(`\n项目:${proj.name} (${TARGET})`);
  console.log(`工件 ${views.length} 件 · 工作项 ${works.length} 条 · 库里的 links ${links.length} 条\n`);

  console.log("── 分层(列 = 因果层;同列内按 kind 归堆)──");
  const byDepth = new Map<number, typeof layout.nodes>();
  for (const n of layout.nodes) byDepth.set(n.depth, [...(byDepth.get(n.depth) ?? []), n]);
  for (const [d, nodes] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`第 ${d} 列(${nodes.length} 件)`);
    for (const n of nodes) {
      console.log(`    · [${n.artifact.kind}] ${n.artifact.title || n.artifact.id}` +
        (n.workTitle === null ? "   ← 不挂任何工作项" : ""));
    }
  }

  console.log("\n── 边 ──");
  for (const r of ["depends_on", "review_about", "answers", "parent"] as ArtifactRelation[]) {
    console.log(`  ${RELATIONS[r].label}:${layout.stats[r]} 条`);
  }
  const byRel = new Map<string, typeof layout.edges>();
  for (const e of layout.edges) byRel.set(e.rel, [...(byRel.get(e.rel) ?? []), e]);
  for (const [rel, rows] of byRel) {
    console.log(`  ${RELATIONS[rel as ArtifactRelation].label}(${rows.length}):`);
    for (const e of rows.slice(0, 3)) {
      console.log(`    ${t(e.from).slice(0, 34)} → ${t(e.to).slice(0, 34)}`);
    }
    if (rows.length > 3) console.log(`    …另有 ${rows.length - 3} 条`);
  }

  const isolated = layout.nodes.filter((n) => n.inDegree === 0 && n.outDegree === 0);
  console.log(`\n── 孤点(没有任何边,仍然画成一张卡片)── ${isolated.length} 件`);
  for (const n of isolated) {
    console.log(`    · [${n.artifact.kind}] ${n.artifact.title || n.artifact.id}` +
      (n.workTitle === null ? "   ← 不挂任何工作项" : `   ← 产出于「${n.workTitle}」`));
  }
  console.log(
    `\n反向边 ${layout.backwardEdges.length} · 悬空 ${layout.dangling.length}` +
    ` · 排不出先后 ${layout.unlayeredIds.length}` +
    ` · 多目标审查 ${layout.multiTargetReviews}`,
  );
  console.log(`画布 ${Math.round(layout.width)} × ${Math.round(layout.height)} px\n`);

  // 自检:不存在的项目必须**如实报空**,而不是拿上一份结果蒙混过去
  const missing = layoutArtifactGraph([], []);
  console.log(`自检(不存在的项目):节点 ${missing.nodes.length} · 边 ${missing.edges.length}` +
    ` · 画布 ${Math.round(missing.width)}×${Math.round(missing.height)}\n`);
} finally {
  db.close();
}
