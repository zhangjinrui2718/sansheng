/**
 * C3 · `integrate` / `handover`:工件推动流程真正落地的两环(设计 1 §2.11.4 / §2.12)
 *
 * ── 这一批为什么值得单独一个文件 ─────────────────────────────────
 *
 * 流水线此前**停在质检**:`TodoKind` 的 8 个取值里没有「整合」「交付」,
 * 于是「子树都跑完了」这件事在库里没有任何机械读者。C3 补的两条规则各自对应
 * 用户原话里的一环,而它们判的东西**完全不同**:
 *
 *   - `integrate` 的条件侧是**集合 + 状态谓词**(沿 `works.parent_work_id` 的子树
 *     全部终态、每条 done 的都审过)—— 它**不能**是纯工件判据:一个 `cancelled`
 *     的子项没有工件,纯工件判据会让里程碑永不达成(§2.11.2 的第一条反例)。
 *   - 但 `integrate` 的**终止**判据必须是**工件**:根工作项上有一条 `deliverable`。
 *     没有它,`if` 每个 tick 都成立,规则会一直叫到尝试预算用尽 —— 而预算按
 *     AGENTS.md 的定性是**限流不是判据**,拿它兜一条每次都成立的规则,等于让流水线
 *     静默停在一个「看起来跑过很多次」的地方(本文件最后一组就是这个现场)。
 *   - `handover` 两侧都是工件:资格 = `deliverable` + `accepted`,终止 = **交付会话**
 *     那条边(`project_sessions.deliverable_artifact_id`,C4 的 migration 017)。
 *
 * ── 「扁平库」这一条是刻意测的(§9.4)────────────────────────────
 *
 * `integrate` 按「根工作项的子树」判定,而真机库是**扁平**的(9 work / 9 root /
 * 0 中间)。§9.4 明写它「必须同时容忍扁平库 —— 扁平时每个根就是它自己,子树判据
 * 退化成单条工作项判据」。两个方向都要钉:
 *   - 单条根 `done` + 审过 ⇒ **触发**(否则真机上这条规则永远不动);
 *   - 单条根还在 `open` ⇒ **不触发**(否则空集上「后代全部终态」恒真,刚拆完
 *     就会把项目经理叫来整合)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, markWorkReviewed, type WorkStatus,
} from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { openDeliverableSession } from "../../src/platform/storage/repo/sessions.js";
import {
  collectTodos, drainProject, renderTask, RULES,
  type DrainTurnReport,
} from "../../src/platform/runtime/dispatcher.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

/** 造一条工作项(树的形状由 `parent` 决定)。 */
function mkWork(over: {
  id?: string; parent?: string | null; title?: string; status?: WorkStatus;
} = {}): string {
  const id = over.id ?? `wk_${++seq}`;
  insertWork(db, {
    id, projectId: "p1", parentWorkId: over.parent ?? null,
    title: over.title ?? `工作项 ${id}`, goal: "写出结论",
    status: over.status ?? "open", assigneeAgentId: "wk",
    createdAt: T0 + seq, updatedAt: T0 + seq,
  });
  return id;
}

/** `done` + **已审**(质检跑过的现场:平台在回合成功后写 `review_state='done'`)。 */
function mkReviewedDone(over: { id?: string; parent?: string | null; title?: string } = {}): string {
  const id = mkWork({ ...over, status: "done" });
  markWorkReviewed(db, id, T0 + 500);
  return id;
}

function mkArtifact(over: {
  id?: string; kind?: string; status?: string; workId?: string | null; author?: string;
} = {}): string {
  const id = over.id ?? `art_${++seq}`;
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: (over.kind ?? "evidence") as "evidence",
    status: (over.status ?? "open") as "open",
    authorAgentId: over.author ?? "pm",
    title: `工件 ${id}`, body: "正文(判定不该读它)",
    metadataJson: null, createdAt: T0 + 900, updatedAt: T0 + 900,
    workId: over.workId ?? null,
  });
  return id;
}

const board = (now = T0) => collectTodos({ db, projectId: "p1", now });
const kinds = (now = T0): string[] => board(now).runnable.map((t) => `${t.kind}:${t.agentId}`).sort();
const integrateTodo = (now = T0) => board(now).runnable.find((t) => t.kind === "integrate");
const handoverTodo = (now = T0) => board(now).runnable.find((t) => t.kind === "handover");

const okTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "好了", toolCalls: [] };

/** 规则表里那两条(不存在时给出**指名道姓**的失败,而不是 `undefined.id` 的 TypeError)。 */
function ruleOf(id: string) {
  const r = RULES.find((x) => x.id === id);
  if (r === undefined) throw new Error(`规则表里没有 ${id}`);
  return r;
}

// ══════════════════════════════════════════════════════════════════
// ① 规则表:两条新规则的形状
// ══════════════════════════════════════════════════════════════════

describe("C3 · 规则形状(§2.11.4 的下两行)", () => {
  it("两条规则都在,各带 `on` / `then` / `why`(why 是写给人读的现场)", () => {
    const integrate = ruleOf("integrate_reviewed_subtree");
    const handover = ruleOf("handover_deliverable");
    expect(integrate.then).toEqual({ kind: "integrate", targetRole: "project_manager" });
    expect(handover.then).toEqual({ kind: "handover", targetRole: "business_manager" });
    for (const r of [integrate, handover]) {
      expect(r.on.length, `${r.id} 的 on 是空的`).toBeGreaterThan(0);
      expect(r.why.length, `${r.id} 没有 why`).toBeGreaterThan(50);
      expect(r.on, `${r.id} 漏了 tick:重启后补跑靠它`).toContain("tick");
    }
    // 触发侧:工件事件这一批里**第一次**真的有人用(B1 实测 8 条规则一条都没用)
    expect(integrate.on).toEqual(["work_status_changed", "artifact_inserted", "tick"]);
    expect(handover.on).toEqual(["artifact_inserted", "tick"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// ② integrate:集合 + 状态谓词(树上)
// ══════════════════════════════════════════════════════════════════

describe("C3 · `integrate` 的条件侧:根 R 的整棵子树都收口了", () => {
  it("**正样本**:三条子项全终态、done 的都审过 → 叫醒项目经理,refs = 那条根", () => {
    const root = mkWork({ id: "R", title: "交付:选型建议" });
    mkReviewedDone({ id: "c1", parent: root, title: "路线 A" });
    mkReviewedDone({ id: "c2", parent: root, title: "路线 B" });
    const t = integrateTodo();
    expect(t, "子树收口之后流水线必须有人推 —— 这一条就是 C3 补的那一环").toBeDefined();
    expect(t).toMatchObject({ agentId: "pm", role: "project_manager", refs: [root] });
    expect(t?.key).toBe("integrate:R");
    expect(t?.label).toContain("交付:选型建议");
    // **负样本自检**:同一次断言必须能看见别的 kind 也在表里(否则「有 integrate」
    // 可能只是因为看板把什么都列出来了)
    expect(kinds()).toContain("execute_work:wk");
  });

  it("子项**未全终态** → 不触发(有人还在干活,整合是提前的)", () => {
    const root = mkWork({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    mkWork({ id: "c2", parent: root, status: "in_progress" });
    expect(integrateTodo()).toBeUndefined();
    // 正样本自检:c2 一终态,它立刻出现(证明上面那个 undefined 不是「规则整体不工作」)
    db.prepare(`UPDATE works SET status = 'done', review_state = 'done' WHERE id = 'c2'`).run();
    expect(integrateTodo()).toBeDefined();
  });

  it("全终态但**有一条 `done` 没审** → 不触发(先把 `review_work` 跑掉)", () => {
    const root = mkWork({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    mkWork({ id: "c2", parent: root, status: "done" }); // review_state = pending
    expect(integrateTodo()).toBeUndefined();
    // 而且这时质检的待办**确实**在(否则「不触发」可能只是因为整条链没动)
    expect(kinds()).toContain("review_work:qa");
    markWorkReviewed(db, "c2", T0 + 600);
    expect(integrateTodo()).toBeDefined();
  });

  it("**`cancelled` 的子项按 §2.8 算收口** —— 它不该把里程碑永久钉死", () => {
    const root = mkWork({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    mkWork({ id: "c2", parent: root, status: "cancelled" }); // 这块范围不要了
    expect(integrateTodo(), "取消 = 收口,不是阻塞(§2.11.2 的第一条反例)").toBeDefined();
  });

  it("`failed` 的子项也算收口 —— 但子树里**一条 `done` 都没有**时不整合", () => {
    const root = mkWork({ id: "R" });
    mkWork({ id: "c1", parent: root, status: "failed" });
    mkWork({ id: "c2", parent: root, status: "cancelled" });
    expect(integrateTodo(), "没有产出可整合:失败该走「向甲方交代」,不是「交付」").toBeUndefined();
    // 正样本:同一棵树里有一条 done(审过)→ 立刻触发
    mkReviewedDone({ id: "c3", parent: root });
    expect(integrateTodo()).toBeDefined();
  });

  it("根 R 自己 `cancelled` → 不触发(整块范围不要了,没有交付可言)", () => {
    const root = mkWork({ id: "R", status: "cancelled" });
    mkReviewedDone({ id: "c1", parent: root });
    expect(integrateTodo()).toBeUndefined();
    // 正样本:同一形状、R 不取消 → 触发
    const root2 = mkWork({ id: "R2" });
    mkReviewedDone({ id: "c2", parent: root2 });
    expect(integrateTodo()?.refs).toEqual(["R2"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ integrate:扁平库(§9.4 明写要容忍)
// ══════════════════════════════════════════════════════════════════

describe("C3 · `integrate` 必须容忍扁平库(§9.4:真机库是 9 work / 9 root / 0 中间)", () => {
  it("单条根 `done` + 审过 → 触发(子树判据退化成单条工作项判据)", () => {
    const w = mkReviewedDone({ id: "w_flat", title: "扁平交付" });
    const t = integrateTodo();
    expect(t).toBeDefined();
    expect(t?.refs).toEqual([w]);
    expect(t?.label).toContain("扁平交付");
  });

  it("单条根还在 `open` → **不触发**(空集上「后代全部终态」恒真,那会在刚拆完就整合)", () => {
    mkWork({ id: "w_open" });
    expect(integrateTodo()).toBeUndefined();
  });

  it("**一条待办覆盖全部就绪的根**(不是一个根一条):进度 = key 变了", () => {
    mkReviewedDone({ id: "r1" });
    mkReviewedDone({ id: "r2" });
    const t = integrateTodo();
    expect(t?.refs).toEqual(["r1", "r2"]);
    expect(t?.key).toBe("integrate:r1+r2");
    // 项目经理整合掉 r1(写出它那条交付物)→ 集合缩小 ⇒ **key 变了** ⇒ 新预算。
    // 这正是「不是每个根一条待办」的理由:一个回合可以整合多条,而进度仍看得见。
    mkArtifact({ id: "d1", kind: "deliverable", workId: "r1" });
    expect(integrateTodo()?.refs).toEqual(["r2"]);
    expect(integrateTodo()?.key).toBe("integrate:r2");
  });
});

// ══════════════════════════════════════════════════════════════════
// ④ integrate 的**终止判据**(交付物这个 kind 存在的理由)
// ══════════════════════════════════════════════════════════════════

describe("C3 · `integrate` 的终止判据:R 上有了 `deliverable` 就**不再触发**", () => {
  it("根上写出 `deliverable` → 规则不再触发(否则会反复叫到预算用尽)", () => {
    const root = mkReviewedDone({ id: "R" });
    expect(integrateTodo()).toBeDefined();
    mkArtifact({ id: "d1", kind: "deliverable", workId: root });
    expect(integrateTodo(), "「整合完了」的唯一答案是那条工件").toBeUndefined();
    // 负样本:换一个 kind 就不算整合过(判据是 kind,不是「写了点什么」)
    db.prepare(`DELETE FROM artifacts WHERE id = 'd1'`).run();
    mkArtifact({ id: "d2", kind: "evidence", workId: root });
    expect(integrateTodo()).toBeDefined();
  });

  it("产出边挂在**子项**上也算(边挂错地方不该导致反复叫醒)", () => {
    const root = mkWork({ id: "R" });
    const kid = mkReviewedDone({ id: "c1", parent: root });
    mkArtifact({ id: "d_kid", kind: "deliverable", workId: kid });
    expect(integrateTodo()).toBeUndefined();
  });

  it("**不挂产出边**的 `deliverable` 不算 —— 所以任务提示词必须点名 `workId`", () => {
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d_orphan", kind: "deliverable", workId: null });
    expect(integrateTodo(), "挂不到根上的交付物推不动流水线(提示词因此要说清 workId)").toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ handover:资格 = accepted 的交付物;终止 = 交付会话
// ══════════════════════════════════════════════════════════════════

describe("C3 · `handover`:把已验收的交付物交到业务经理手上", () => {
  it("有 `deliverable` + `accepted` → 叫醒业务经理", () => {
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d1", kind: "deliverable", status: "accepted", workId: "R", author: "pm" });
    const t = handoverTodo();
    expect(t).toBeDefined();
    expect(t).toMatchObject({ agentId: "bm", role: "business_manager", refs: ["d1"] });
    expect(t?.target).toBe("d1");
    expect(t?.label).toContain("工件 d1");
  });

  it("**没有 accepted 的交付物时不触发**:`open` / `evidence` 都不算", () => {
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d_open", kind: "deliverable", status: "open", workId: "R" });
    expect(handoverTodo(), "整合刚写完、还没验收时不该惊动甲方").toBeUndefined();
    mkArtifact({ id: "e1", kind: "evidence", status: "accepted", workId: "R" });
    expect(handoverTodo(), "别的 kind 验收了也不是交付物").toBeUndefined();
    // 正样本:把它写成 accepted 就触发(证明上面不是「规则整体不工作」)
    db.prepare(`UPDATE artifacts SET status = 'accepted' WHERE id = 'd_open'`).run();
    expect(handoverTodo()?.refs).toEqual(["d_open"]);
  });

  it("**终止判据(C4 已落地)**:交付会话一建出来,规则就不再触发", () => {
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d1", kind: "deliverable", status: "accepted", workId: "R" });
    expect(handoverTodo()).toBeDefined();

    // ── 017 之后:`project_sessions` 真的有两个新列,这里**直接用真 schema** ──
    //    (C3 那版是手工 `ALTER TABLE ADD COLUMN` —— 017 一落地它就撞
    //     `duplicate column name`,所以那些手工 DDL 全部删掉,改成断言 017 的产物)
    const cols = (db.pragma("table_info(project_sessions)") as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols, "017 的握手协议列:名字不一样,`handover` 永远不会终止")
      .toContain("deliverable_artifact_id");
    expect(cols, "017 的通道列").toContain("channel");

    // 负样本:列在、但**还没有会话** → 判据照旧成立(不是「加了列就永不再触发」)
    expect(handoverTodo()).toBeDefined();
    // 平台在 `handover` 回合成功后做的正是这一句(`drainProject` 的消费块第三支)
    const opened = openDeliverableSession(db, {
      projectId: "p1", deliverableArtifactId: "d1", channel: "client", createdAt: T0 + 1000,
    });
    expect(opened.created).toBe(true);
    expect(handoverTodo(), "已经有交付会话 ⇒ 这一环做过了").toBeUndefined();
    // **幂等**:同一个交付物只建一条会话(at-least-once 的重放是安全的)
    const again = openDeliverableSession(db, {
      projectId: "p1", deliverableArtifactId: "d1", channel: "client", createdAt: T0 + 2000,
    });
    expect(again).toEqual({ created: false, sessionId: opened.sessionId });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM project_sessions WHERE project_id = 'p1'`).get(),
    ).toEqual({ n: 1 });
  });

  it("列**不在**时不假装已交付:待办照样产出来(读面先问 schema,不靠异常)", () => {
    // 017 之后这一列在生产路径上永远在(迁移每次 boot 都跑)。所以这条用例**自己
    // 造一个「列不在」的库**:DROP COLUMN 之后判据必须如实退化成「还没有交付会话」。
    // 没有这条负样本,`deliveredArtifactIds` 里那段 `PRAGMA table_info` 就是一段
    // 谁也没走过、也测不到的死代码(AGENTS.md:「有声明没读者」要定期复核)。
    const cols = (db.pragma("table_info(project_sessions)") as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols, "自检:017 落地之后这一列必须在(不在说明迁移没跑上)").toContain(
      "deliverable_artifact_id",
    );
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d1", kind: "deliverable", status: "accepted", workId: "R" });
    // 正样本:列在、没有会话 ⇒ 该交付
    expect(handoverTodo()).toBeDefined();
    // 平台已经交付过一次(真的落了一条会话)—— 此刻规则**不该**再触发
    openDeliverableSession(db, {
      projectId: "p1", deliverableArtifactId: "d1", channel: "client", createdAt: T0 + 1000,
    });
    expect(handoverTodo()).toBeUndefined();

    db.exec(`ALTER TABLE project_sessions DROP COLUMN deliverable_artifact_id`);
    // 列没了 ⇒ 读面**如实**返回空集(「还没有任何交付会话」),不假装已交付
    expect(handoverTodo(), "列不在 ⇒ 判据如实退化,而不是抛错 / 假装成立").toBeDefined();
    // 恢复:把列加回来。⚠️ SQLite 的 `DROP COLUMN` 是**重写行**,那条边的值跟着没了
    // (会话行还在,但 `deliverable_artifact_id` 变成 NULL)—— 所以恢复要两步:
    // 先加列,再回填那条边。这是 SQLite 的语义,不是本模块的取舍。
    db.exec(`ALTER TABLE project_sessions ADD COLUMN deliverable_artifact_id TEXT REFERENCES artifacts(id)`);
    expect(handoverTodo(), "列回来但值没回填 ⇒ 判据仍然不成立(如实)").toBeDefined();
    db.prepare(`UPDATE project_sessions SET deliverable_artifact_id = 'd1' WHERE id = 's_deliv_d1'`).run();
    expect(handoverTodo(), "边回填之后,终止判据照旧成立").toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑥ 任务提示词:约束① —— 必须告诉项目经理「什么时候写交付物」
// ══════════════════════════════════════════════════════════════════

describe("C3 · `integrate` 的任务提示词(否则 `deliverable` 只开写面、无人知道何时用)", () => {
  it("正文点名 `deliverable` / `workId` / 根工作项 id / `accepted` —— 四样缺一不可", () => {
    const root = mkWork({ id: "R", title: "交付:选型建议" });
    mkReviewedDone({ id: "c1", parent: root, title: "路线 A" });
    const t = integrateTodo();
    expect(t).toBeDefined();
    const text = renderTask(db, t!);
    expect(text).toContain("deliverable");
    expect(text).toContain("workId");
    expect(text).toContain("R"); // 具体是哪条根工作项要挂边
    expect(text).toContain("accepted"); // 交付那一环的资格判据
    // 现场:子树里每条子项都要能被看见(它据此决定整合什么)
    expect(text).toContain("路线 A");
    expect(text).toContain("c1");
    // 边界:整合不是自己去做子项里的活
    expect(text).toContain("不要自己动手");
  });

  it("扁平库的那一支也说得出「交付物挂在哪条工作项上」", () => {
    const w = mkReviewedDone({ id: "w_flat", title: "扁平交付" });
    const text = renderTask(db, integrateTodo()!);
    expect(text).toContain("w_flat");
    expect(text).toContain("没有子项");
    expect(w).toBe("w_flat");
  });

  it("`handover` 的任务提示词把「交付物」这个**事实**摆出来(不承诺平台还没做的事)", () => {
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d1", kind: "deliverable", status: "accepted", workId: "R" });
    const text = renderTask(db, handoverTodo()!);
    expect(text).toContain("d1");
    expect(text).toContain("已验收");
    expect(text, "不要在提示词里许一个平台还没做的承诺(C4 还没落地)").not.toContain("我会");
    expect(text).toContain("不要在这里重新整合");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑦ 排空:两环真的接起来 + 「预算是限流不是判据」的现场
// ══════════════════════════════════════════════════════════════════

describe("C3 · 排空:整合 → 交付", () => {
  /** 假的项目经理:被叫醒整合时写出**已验收**的交付物(它按提示词做事)。 */
  const pmWritesDeliverable = (agentId: string, task: string): void => {
    if (agentId !== "pm" || !task.startsWith("# 现在轮到你了:整合这条交付")) return;
    const roots = db
      .prepare(`SELECT id FROM works WHERE project_id = 'p1' AND parent_work_id IS NULL`)
      .all() as Array<{ id: string }>;
    for (const r of roots) {
      mkArtifact({ id: `art_d_${r.id}`, kind: "deliverable", status: "accepted", workId: r.id });
    }
  };

  it("子树收口 → **项目经理被叫醒一次** → 写出交付物 → **业务经理被叫醒交付**", async () => {
    // 根工作项本身是 `done` + 审过:树里的**容器**在真机上也得有人收口
    // (否则它自己会是一条 `execute_work` —— 见报告里的 open question)
    const root = mkReviewedDone({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    mkReviewedDone({ id: "c2", parent: root });

    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, reportBatchSize: 1,
      // `maxAttemptsPerTodo: 1` 在这里**不参与判定**:交付会话由消费块第三支
      // (C4)在业务经理那个回合成功后建出来,所以 `handover` 只可能跑一次。
      maxAttemptsPerTodo: 1,
      runAgentTurn: async (agentId, task) => { pmWritesDeliverable(agentId, task); return okTurn; },
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    });
    expect(r.visited.map((v) => `${v.agentId}:${v.kind}`)).toEqual([
      "pm:integrate", "bm:handover",
    ]);
  });

  it("**终止判据生效 ⇒ 整合只叫醒一次**:第二次排空不再有 integrate", async () => {
    const root = mkReviewedDone({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    const deps = {
      db, projectId: "p1" as const, now: () => T0, log: () => {}, reportBatchSize: 1,
      runAgentTurn: async (agentId: string, task: string) => {
        pmWritesDeliverable(agentId, task);
        return okTurn;
      },
      runWork: async () => { throw new Error("不该被调用"); },
    };
    const first = await drainProject(deps);
    expect(first.visited.some((v) => v.kind === "integrate")).toBe(true);
    const second = await drainProject(deps);
    expect(second.visited.some((v) => v.kind === "integrate"), "③ 生效:不再重复叫醒").toBe(false);
  });

  it("**缺了终止判据的现场**:项目经理不写交付物 ⇒ 被叫到预算用尽(所以判据不可省)", async () => {
    const root = mkReviewedDone({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 2,
      reportBatchSize: 1,
      runAgentTurn: async () => okTurn, // ← 假经理什么都不做
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.visited.filter((v) => v.kind === "integrate")).toHaveLength(2);
    expect(r.stopReason).toBe("no_progress");
    expect(r.newlyExhausted.map((t) => t.kind)).toContain("integrate");
    // 这正是「预算不是判据」的现场:它按 (项目, 待办 key) 记账,到界就不再叫醒,
    // 而流水线会**静默停在**「看起来跑过很多次」的地方 —— 所以 `deliverable`
    // 那条终止判据是必须的,不是可选的美化。
    expect(r.stopDetail).toContain("尝试预算");
  });

  it("C4 之后,交付那一环**有**终点了:`handover` 只被叫醒一次", async () => {
    mkReviewedDone({ id: "R" });
    mkArtifact({ id: "d1", kind: "deliverable", status: "accepted", workId: "R" });
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 2,
      reportBatchSize: 1,
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    // C3 时这条断言是 `toBe(2)`,钉的是**缺口**(没有交付会话 ⇒ 判据不成立 ⇒
    // 按预算重复)。017 + 消费块第三支落地之后,它必须变成 1 —— 终止判据真的成立。
    const handed = r.visited.filter((v) => v.kind === "handover").length;
    expect(handed, "交付会话建出来了 ⇒ 终止判据成立 ⇒ 不再重复叫醒").toBe(1);
    // 而且那条会话真的落在库里(不是「规则不叫了」而已)
    expect(
      db.prepare(`SELECT id, channel, deliverable_artifact_id FROM project_sessions`)
        .all(),
    ).toEqual([{ id: "s_deliv_d1", channel: "client", deliverable_artifact_id: "d1" }]);
    // 第二次排空:整条交付链都没有待办了(这才是「有终点」的完整形态)
    const second = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 2,
      reportBatchSize: 1,
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(second.visited, "第二次 tick 谁都不该被叫醒").toEqual([]);
  });
});
