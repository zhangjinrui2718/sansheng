/**
 * 甲方的验收裁决(029)· 全链验收
 *
 * ── 这一批改的是什么 ────────────────────────────────────────────
 *
 * 用户裁决(2026-10-08):
 *   「把甲方从『只读观察者』变成闭环里的一等主体:交付 → 甲方验收 → 收口 / 返工 / 下一版」
 *   「只有甲方认可了之后,项目才算是结项,业务经理把交付物给到甲方之后,
 *     项目进入『待收货』状态」
 *
 * 改之前那道门是**假门**:交付与收口的资格判据都是
 * 「存在 `status='accepted'` 的 `deliverable`」,而那个 `accepted` 是**申请人自己写的**
 * (`project_manager.core.md` 逐字教它这么写;真机库 7 份交付物全部 `accepted`,
 * 作者是 `wk` / `pm` 自己)。⇒ 门的判据 = 申请人的自我声明,而收口**不可逆**。
 *
 * ── 这份文件逐条钉住的东西 ──────────────────────────────────────
 *
 *   ① **唯一写入口是 HTTP**(`POST /api/artifacts/:id/verdict`)。任何角色都没有
 *      这个能力 —— 模型不能替甲方拍板。四条拒收都要有:**不是交付物 / 已收口 /
 *      还没交付给你 / verdict 非法**。
 *   ② **追加式**:改判再写一条,历史两行都在;读面取最新那条(改判留痕,与 021 同)。
 *   ③ **收口门真的读它**:甲方接受之前 `close_project` 不成立、`project_close`
 *      工具**当场拒**;接受之后两者都成立。这是这次改动唯一的牙。
 *   ④ **拒收要有人接手**:`rework_rejected` 待办、目的地 = 产出的作者
 *      (第 3 轮换人给 PM,与质检返工共用 `reworkOwner`)。
 *   ⑤ **终止判据是「那之后有了新产出」** —— 没有它,甲方那行裁决是过去式,
 *      规则每个 tick 都成立,只能靠尝试预算兜住(而预算是限流不是判据)。
 *   ⑥ **「待收货」是派生状态**:库里 `projects.status` 仍是 `active`,
 *      读面按「已交付 ∧ 无裁决」算出来。判据与收口门**同源**。
 *   ⑦ **验收之后旧版本退休**:作者重交时被拒的那一版必须被标 `superseded`,
 *      否则收口门会读到一个**永远消不掉的拒收**(项目永远收不了口)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, loadProjectForAuthz, getProjectRow,
} from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { insertArtifact, getArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { openDeliverableSession } from "../../src/platform/storage/repo/sessions.js";
import {
  deliveryAcceptance, insertDeliveryVerdict, latestDeliveryVerdict,
  listDeliveryVerdicts,
} from "../../src/platform/storage/repo/deliveryVerdicts.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { collectTodos } from "../../src/platform/runtime/dispatcher.js";
import {
  toArtifactView, toProjectDetail, toProjectSummary,
} from "../../src/platform/transport/views.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOOL_INDEX } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { ArtifactAcceptanceView } from "@shared/types/platform.js";

const T0 = 1_700_000_000_000;
const P = "p_accept";
const BM = "bm";
const PM = "pm";
const WK = "wk";

let db: Database.Database;
let seq = 0;
/** `board_write` 要落正文文件(027)⇒ 夹具需要一个真的工作区。 */
let workRoot = "";

function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "sansheng-accept-"));
  seq = 0;
  insertProject(db, {
    id: P, name: "验收流程", client: "甲方", goal: "交一份东西出来",
    status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, P, T0);
  insertWork(db, {
    id: "wk_root", projectId: P, parentWorkId: null, title: "最终交付",
    goal: "整合成一份", status: "done", assigneeAgentId: WK,
    createdAt: T0, updatedAt: T0,
  });
});

afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

/** 一份**已交付**的定稿交付物(`status='accepted'` = 定稿,不是「甲方验收了」)。 */
function seedDelivered(over: {
  artifactId?: string;
  workId?: string | null;
  author?: string;
  createdAt?: number;
  delivered?: boolean;
  title?: string;
} = {}): string {
  const id = over.artifactId ?? `art_d${(seq += 1)}`;
  insertArtifact(db, {
    id, projectId: P, conversationId: null, kind: "deliverable",
    status: "accepted", authorAgentId: over.author ?? WK,
    title: over.title ?? "最终交付物",
    ...bodyAt(`artifacts/${id}.html`, "<h1>正文</h1>"),
    metadataJson: null, createdAt: over.createdAt ?? T0 + 1, updatedAt: over.createdAt ?? T0 + 1,
    workId: over.workId === undefined ? "wk_root" : over.workId,
    deliverableType: "html_report",
  });
  if (over.delivered !== false) {
    openDeliverableSession(db, {
      id: `s_${id}`, projectId: P, deliverableArtifactId: id, createdAt: T0 + 2,
    });
  }
  return id;
}

// ── HTTP 面 ──────────────────────────────────────────────────────

function app(): ReturnType<typeof createPlatformApp> {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/delivery-acceptance-test",
    cwd: "/tmp/delivery-acceptance-test-root",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => T0 + 10,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/x", factoryDir: "/tmp/y" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
  };
  return createPlatformApp(deps);
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text) as unknown; } catch { parsed = null; }
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
}

const verdictUrl = (id: string): string => `/api/artifacts/${id}/verdict`;

// ══════════════════════════════════════════════════════════════════
// ① 唯一写入口 = HTTP;四条拒收
// ══════════════════════════════════════════════════════════════════

describe("① `POST /api/artifacts/:id/verdict`:只有甲方能写下「收不收」", () => {
  it("正样本:接受 ⇒ 200,落一行 accept,且回包给的是**重算的**收货进展", async () => {
    const id = seedDelivered();
    const r = await post(verdictUrl(id), { verdict: "accept" });
    expect(r.status).toBe(200);
    const acc = (r.body as { acceptance: ArtifactAcceptanceView }).acceptance;
    expect(acc.verdict).toBe("accept");
    expect(acc.handedOver).toBe(true);
    expect(acc.at).toBe(T0 + 10);
    expect(latestDeliveryVerdict(db, id)?.verdict).toBe("accept");
  });

  it("正样本:拒收带理由 ⇒ 理由原样落库(它是作者唯一的现场)", async () => {
    const id = seedDelivered();
    const r = await post(verdictUrl(id), { verdict: "reject", note: "第三章的接口对不上" });
    expect(r.status).toBe(200);
    expect(latestDeliveryVerdict(db, id)?.note).toBe("第三章的接口对不上");
  });

  it("负样本:不是交付物 ⇒ 400(给 evidence 盖章是没有意义的)", async () => {
    insertArtifact(db, {
      id: "art_ev", projectId: P, conversationId: null, kind: "evidence",
      status: "open", authorAgentId: WK, title: "证据",
      ...bodyAt("artifacts/art_ev.md", "x"),
      metadataJson: null, createdAt: T0, updatedAt: T0, workId: null,
    });
    const r = await post(verdictUrl("art_ev"), { verdict: "accept" });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("invalid_args");
  });

  it("负样本:**还没交付给你** ⇒ 409(没收到货,谈不上验收)", async () => {
    const id = seedDelivered({ delivered: false });
    const r = await post(verdictUrl(id), { verdict: "accept" });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("not_delivered");
    // 而且真的没落行 —— 拒收要拒得干净
    expect(listDeliveryVerdicts(db, P)).toEqual([]);
  });

  it("负样本:项目已收口 ⇒ 409(收口不可逆,之后验收等于给结论补签)", async () => {
    const id = seedDelivered();
    db.prepare(`UPDATE projects SET status = 'done' WHERE id = ?`).run(P);
    const r = await post(verdictUrl(id), { verdict: "accept" });
    expect(r.status).toBe(409);
    expect((r.body as { error: { code: string } }).error.code).toBe("project_closed");
  });

  it("负样本:verdict 非法 / 换名字写 ⇒ 400(闭集只有一个答案)", async () => {
    const id = seedDelivered();
    for (const bad of ["accepted", "PASS", "", null, 1]) {
      const r = await post(verdictUrl(id), { verdict: bad });
      expect(r.status, `verdict=${String(bad)} 必须被拒`).toBe(400);
    }
    // 尤其是这一条:拿工件状态机的词(`accepted`)来当裁决的词 —— 两套闭集不许混
    expect(listDeliveryVerdicts(db, P)).toEqual([]);
  });

  it("负样本:工件不存在 ⇒ 404", async () => {
    const r = await post(verdictUrl("art_nope"), { verdict: "accept" });
    expect(r.status).toBe(404);
  });

  it("负样本:理由太长(>2000 字)⇒ 400 —— 它会**逐字**进返工任务正文", async () => {
    const id = seedDelivered();
    const r = await post(verdictUrl(id), { verdict: "reject", note: "长".repeat(2001) });
    expect(r.status).toBe(400);
    expect(listDeliveryVerdicts(db, P)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 追加式:改判留痕
// ══════════════════════════════════════════════════════════════════

describe("② 改判:追加而不是覆盖(只留最后一条 = 改判现场消失)", () => {
  it("先拒收、再接受 ⇒ 两行都在,读面取最新那条", async () => {
    const id = seedDelivered();
    await post(verdictUrl(id), { verdict: "reject", note: "要改" });
    await post(verdictUrl(id), { verdict: "accept" });

    const all = listDeliveryVerdicts(db, P);
    expect(all).toHaveLength(2);
    expect(all.map((v) => v.verdict)).toEqual(["reject", "accept"]);
    // 负样本:历史那一条**没有被改写成** accept(「改判」不是「抹掉上一次」)
    expect(all[0]!.note).toBe("要改");
    expect(latestDeliveryVerdict(db, id)?.verdict).toBe("accept");
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ 收口门真的读它 —— 这次改动的牙
// ══════════════════════════════════════════════════════════════════

describe("③ 收口门:甲方接受之前收不了口,接受之后才成立", () => {
  const closeTodo = (): boolean =>
    collectTodos({ db, projectId: P, now: T0 + 20 }).runnable.some((t) => t.kind === "close_project");

  function finishProject(): void {
    // 工作项 done + 已审 + 交付物已交付:除了「甲方验收」之外**每一格都成立**
    insertArtifact(db, {
      id: "art_brief", projectId: P, conversationId: null, kind: "work_brief",
      status: "open", authorAgentId: PM, title: "工作说明",
      ...bodyAt("artifacts/art_brief.md", "x"),
      metadataJson: null, createdAt: T0, updatedAt: T0, workId: "wk_root",
    });
    // review_verdicts 置 pass(否则「待审产出」那一格不成立)
    db.prepare(
      `INSERT INTO review_verdicts (work_id, project_id, verdict, severity, finding_artifact_id, note, reviewed_by, created_at)
       VALUES (?, ?, 'pass', 'low', NULL, NULL, ?, ?)`,
    ).run("wk_root", P, "qa", T0 + 1);
    db.prepare(`UPDATE works SET review_state = 'done' WHERE id = 'wk_root'`).run();
  }

  it("正样本:甲方接受 ⇒ 收口待办出现(证明门是**被挡**,不是坏了)", () => {
    finishProject();
    seedDelivered();
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_d1", verdict: "accept", note: null, createdAt: T0 + 5,
    });
    expect(closeTodo()).toBe(true);
  });

  it("**牙**:只有作者写的 `accepted`、甲方没表态 ⇒ 收口待办**不出现**", () => {
    finishProject();
    seedDelivered();
    // 这一条正是改之前会成立的那种形态(作者的自我声明)
    expect(getArtifact(db, "art_d1")?.status).toBe("accepted");
    expect(closeTodo(), "「定稿」不是「甲方验收了」").toBe(false);
  });

  it("甲方拒收 ⇒ 同样不成立(而且此时该有人去返工)", () => {
    finishProject();
    seedDelivered();
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_d1", verdict: "reject", note: "要改", createdAt: T0 + 5,
    });
    expect(closeTodo()).toBe(false);
    expect(
      collectTodos({ db, projectId: P, now: T0 + 20 }).runnable.map((t) => t.kind),
      "拒收要有人接手 —— 否则项目永远 active 且没有人在动",
    ).toContain("rework_rejected");
  });
});

// ══════════════════════════════════════════════════════════════════
// ④ `project_close` 工具:模型不能绕过这道门
// ══════════════════════════════════════════════════════════════════

describe("④ `project_close`:模型直接调也绕不过去", () => {
  function closeTool(): (args: Record<string, unknown>) => ToolResult {
    const tool = TOOL_INDEX.get("project_close");
    if (tool === undefined) throw new Error("project_close 不在工具表里");
    const ctx = {
      db,
      agent: { id: BM, role: "business_manager", specialization: null, displayName: "业务经理" },
      project: loadProjectForAuthz(db, P),
      now: () => T0 + 30,
      newId: (prefix: string) => `${prefix}_${(seq += 1)}`,
    } as unknown as ToolRunContext;
    return (args) => {
      const r = tool.run(args, ctx);
      if (r instanceof Promise) throw new Error("project_close 必须是同步的");
      return r;
    };
  }

  it("待收货时 `done` 被拒,**如实说出还差哪几份** + 可执行的处置", () => {
    const id = seedDelivered({ title: "美股完整方案" });
    const r = closeTool()({ outcome: "done" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("conflict");
    expect(r.message).toContain("甲方还没认可");
    expect(r.message).toContain("美股完整方案");
    expect(r.alternatives ?? []).toContain("如果这件事不该继续:outcome 用 abandoned(放弃不需要甲方验收)");
    // 而且**真的没关**(不是「报了个错但状态已经变了」)
    expect(getProjectRow(db, P)?.status).toBe("active");
    expect(id.length).toBeGreaterThan(0);
  });

  it("甲方接受 ⇒ 同一个调用成功", () => {
    const id = seedDelivered();
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: id, verdict: "accept", note: null, createdAt: T0 + 5,
    });
    const r = closeTool()({ outcome: "done" });
    expect(r.ok).toBe(true);
    expect(getProjectRow(db, P)?.status).toBe("done");
  });

  it("负样本:`abandoned` **不**受这道门限制(放弃不需要甲方先验收)", () => {
    seedDelivered();
    const r = closeTool()({ outcome: "abandoned", reason: "需求取消了" });
    expect(r.ok).toBe(true);
    expect(getProjectRow(db, P)?.status).toBe("abandoned");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ 拒收 → 返工:目的地与终止判据
// ══════════════════════════════════════════════════════════════════

describe("⑤ 拒收之后有人接手:目的地是产出的作者,终止判据是「那之后有了新产出」", () => {
  const reworkTodo = (now = T0 + 20) =>
    collectTodos({ db, projectId: P, now }).runnable.find((t) => t.kind === "rework_rejected");

  it("正样本:拒收 ⇒ 叫醒**交付物的作者**;第二版落盘 ⇒ 待办消失", () => {
    seedDelivered({ author: WK });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_d1", verdict: "reject", note: "接口对不上", createdAt: T0 + 5,
    });
    const todo = reworkTodo();
    expect(todo, "拒收必须有人接手").toBeDefined();
    expect(todo!.agentId).toBe(WK);
    expect(todo!.target).toBe("art_d1");
    expect(todo!.key).toBe("rework_rejected:art_d1");

    // 作者重交(**同一条工作项**上、比裁决更新的一份定稿)
    seedDelivered({
      artifactId: "art_d2", author: WK, createdAt: T0 + 6, title: "最终交付物(第二版)",
    });
    expect(reworkTodo(T0 + 20), "终止判据:那之后有了新产出").toBeUndefined();
  });

  it("终止判据的**方向**:新产出必须是 `deliverable`(一条 note 不算返工完成)", () => {
    seedDelivered({ author: WK });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_d1", verdict: "reject", note: null, createdAt: T0 + 5,
    });
    insertArtifact(db, {
      id: "art_note", projectId: P, conversationId: null, kind: "note",
      status: "open", authorAgentId: WK, title: "我记一下",
      ...bodyAt("artifacts/art_note.md", "x"),
      metadataJson: null, createdAt: T0 + 6, updatedAt: T0 + 6, workId: "wk_root",
    });
    expect(reworkTodo(), "一条笔记不是返工产出").toBeDefined();
  });

  it("第 3 轮拒收 ⇒ **换人**:退给项目经理(同一件事被同一个人做三次不会有不同结果)", () => {
    seedDelivered({ author: WK });
    for (let i = 0; i < 3; i += 1) {
      insertDeliveryVerdict(db, {
        projectId: P, artifactId: "art_d1", verdict: "reject", note: `第 ${i + 1} 轮`,
        createdAt: T0 + 5 + i,
      });
    }
    expect(reworkTodo()?.agentId).toBe(PM);
  });

  it("作者的产出还在、但它已经不是本项目成员 ⇒ 兜底给 PM(派给不在项目里的人 = 静默停摆)", () => {
    // ⚠️ 用**真实存在但不是本项目成员**的 agent:`artifacts.author_agent_id` 有外键,
    // 编一个不存在的 id 会撞 FOREIGN KEY(那是夹具的错,不是判据的错)。
    insertAgent(db, {
      id: "ag_outsider", role: "research_worker", specialization: "engineering",
      displayName: "已移出的研究员", createdAt: T0,
    });
    seedDelivered({ author: "ag_outsider" });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_d1", verdict: "reject", note: null, createdAt: T0 + 5,
    });
    expect(reworkTodo()?.agentId).toBe(PM);
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑥ 读面:「待收货」是派生的,判据与收口门同源
// ══════════════════════════════════════════════════════════════════

describe("⑥ 读面:待收货 / 待验收清单 / 交付物卡上的裁决", () => {
  it("已交付但甲方没表态 ⇒ `status` 是派生值 `awaiting_acceptance` + 计数 1", () => {
    seedDelivered();
    const s = toProjectSummary(db, getProjectRow(db, P)!);
    expect(s.status).toBe("awaiting_acceptance");
    expect(s.counts.pendingAcceptance).toBe(1);
    // ⚠️ **库里的那一列没变** —— 派生状态不进库(029 文件头那段:重建 `projects`
    // 要动 14 张 CASCADE 子表,而这是一个可以从别处算出来的值)。
    expect(getProjectRow(db, P)?.status).toBe("active");
  });

  it("甲方接受之后 ⇒ 回到 `active`、计数归零", () => {
    const id = seedDelivered();
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: id, verdict: "accept", note: null, createdAt: T0 + 5,
    });
    const s = toProjectSummary(db, getProjectRow(db, P)!);
    expect(s.status).toBe("active");
    expect(s.counts.pendingAcceptance).toBe(0);
  });

  it("负样本:**还没交付**的定稿交付物不算「待收货」(`handover` 那一环还没走)", () => {
    seedDelivered({ delivered: false });
    const s = toProjectSummary(db, getProjectRow(db, P)!);
    expect(s.status).toBe("active");
    expect(s.counts.pendingAcceptance).toBe(0);
  });

  it("负样本:终态项目**不**显示待收货(待收货只精化 `active`)", () => {
    seedDelivered();
    db.prepare(`UPDATE projects SET status = 'paused' WHERE id = ?`).run(P);
    expect(toProjectSummary(db, getProjectRow(db, P)!).status).toBe("paused");
  });

  it("`ProjectDetail.awaitingAcceptance` 带标题与交付时刻 —— 页面不用自己拼", () => {
    const id = seedDelivered({ title: "美股完整方案" });
    const d = toProjectDetail(db, getProjectRow(db, P)!);
    expect(d?.awaitingAcceptance).toHaveLength(1);
    expect(d?.awaitingAcceptance[0]!.artifactId).toBe(id);
    expect(d?.awaitingAcceptance[0]!.title).toBe("美股完整方案");
    expect(d?.awaitingAcceptance[0]!.deliveredAt).toBe(T0 + 2);
    expect(d?.awaitingAcceptance[0]!.deliverableType).toBe("html_report");
  });

  it("交付物卡:`acceptance` 三态分得开(未交付 / 等你验收 / 已裁决)", () => {
    const name = (aid: string): string => aid;
    const un = seedDelivered({ artifactId: "art_un", delivered: false });
    const wait = seedDelivered({ artifactId: "art_wait" });
    const acc = seedDelivered({ artifactId: "art_acc" });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: acc, verdict: "accept", note: null, createdAt: T0 + 7,
    });

    const vUn = toArtifactView(db, getArtifact(db, un)!, name).acceptance;
    const vWait = toArtifactView(db, getArtifact(db, wait)!, name).acceptance;
    const vAcc = toArtifactView(db, getArtifact(db, acc)!, name).acceptance;
    expect(vUn).toEqual({
      handedOver: false, verdict: null, note: null, at: null, projectClosed: false,
    });
    // ⚠️ 「已交付没表态」与「没交付」是**两个不同的答案**(处置:等甲方 vs 等业务经理)
    expect(vWait).toEqual({
      handedOver: true, verdict: null, note: null, at: null, projectClosed: false,
    });
    expect(vAcc?.verdict).toBe("accept");
    expect(vAcc?.at).toBe(T0 + 7);
  });

  it("**收口项目**:读面说「入口关着」,且清单与计数一起归零(三处同口径)", () => {
    const id = seedDelivered();
    db.prepare(`UPDATE projects SET status = 'done' WHERE id = ?`).run(P);

    // ① 交付物卡片:如实说「已交付、从没被验收过,而项目已收口」
    const acc = toArtifactView(db, getArtifact(db, id)!, (x) => x).acceptance;
    expect(acc?.handedOver).toBe(true);
    expect(acc?.verdict).toBeNull();
    expect(acc?.projectClosed, "收口项目上验收入口是关的 —— 后端会 409").toBe(true);

    // ② 项目页的「待你验收」清单**为空**(兑现不了的事不进待办清单)
    const d = toProjectDetail(db, getProjectRow(db, P)!);
    expect(d?.awaitingAcceptance).toEqual([]);
    // ③ 计数与清单同口径(徽标写 7 而清单是空 = 自相矛盾的页面)
    expect(toProjectSummary(db, getProjectRow(db, P)!).counts.pendingAcceptance).toBe(0);
    // 而事实没被删:裁决表照旧可查,交付物照旧在(读面的分家,不是数据的分家)
    expect(deliveryAcceptance(db, P).pending).toEqual([id]);
  });

  it("负样本:`paused` 项目**不**关验收入口(它不是终态,收口还能继续)", () => {
    const id = seedDelivered();
    db.prepare(`UPDATE projects SET status = 'paused' WHERE id = ?`).run(P);
    const acc = toArtifactView(db, getArtifact(db, id)!, (x) => x).acceptance;
    expect(acc?.projectClosed).toBe(false);
    expect(toProjectSummary(db, getProjectRow(db, P)!).counts.pendingAcceptance).toBe(1);
  });

  it("负样本:非交付物没有 `acceptance`(给它一个空对象 = 谎称「有一份在等验收」)", () => {
    insertArtifact(db, {
      id: "art_note2", projectId: P, conversationId: null, kind: "note",
      status: "open", authorAgentId: PM, title: "笔记",
      ...bodyAt("artifacts/art_note2.md", "x"),
      metadataJson: null, createdAt: T0, updatedAt: T0, workId: null,
    });
    expect(toArtifactView(db, getArtifact(db, "art_note2")!, (x) => x).acceptance).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑦ 拒收之后重交:旧版本必须退休
// ══════════════════════════════════════════════════════════════════

describe("⑦ 被拒的那一版要退休 —— 否则收口门读到一个永远消不掉的拒收", () => {
  it("`board_write` 交第二版 ⇒ 被拒的第一版被标 `superseded`,待验收的是新的那一版", () => {
    seedDelivered({ artifactId: "art_v1", author: WK });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_v1", verdict: "reject", note: "要改", createdAt: T0 + 5,
    });
    const tool = TOOL_INDEX.get("board_write");
    if (tool === undefined) throw new Error("board_write 不在工具表里");
    const ctx = {
      db,
      agent: { id: WK, role: "research_worker", specialization: "engineering", displayName: "研究员" },
      project: loadProjectForAuthz(db, P),
      now: () => T0 + 10,
      newId: (prefix: string) => `${prefix}_${(seq += 1)}`,
      // 027 起 `board_write` 先写文件、后插行 ⇒ 工具层必须有工作区
      workspace: createGitWorkspace(),
      workspaceRoot: workRoot,
    } as unknown as ToolRunContext;
    // `board_write` 要落正文文件 ⇒ 没有工作区时报结构化错误而不是抛异常
    const r = tool.run(
      {
        kind: "deliverable", deliverableType: "html_report", status: "accepted",
        title: "最终交付物(第二版)", body: "<h1>改好了</h1>", workId: "wk_root",
      },
      ctx,
    );
    if (r instanceof Promise) throw new Error("board_write 必须是同步的");
    if (!r.ok) throw new Error(`夹具失败:${r.message}`);
    expect(getArtifact(db, "art_v1")?.status).toBe("superseded");

    // ⚠️ **原始判据仍然记得那次拒收**(`deliveryAcceptance` 是「按交付物」的事实,
    // 不按版本过滤):甲方说过的话不会因为作者重交就消失 —— 那是审计面。
    expect(deliveryAcceptance(db, P).rejected).toContain("art_v1");
    // 而**版本敏感的消费者**会把它排除掉(它们各自按 `status='accepted'` 取当前那一版):
    //   · 返工待办:`rework_rejected` 只对当前那一版成立;
    //   · 收口门 / `project_close`:下面那一条直接验证。
    expect(
      collectTodos({ db, projectId: P, now: T0 + 20 }).runnable.map((t) => t.kind),
    ).not.toContain("rework_rejected");
  });

  it("**关键性质**:被拒的那一版退休之后,收口门不会再被它挡住(否则项目永远收不了口)", () => {
    // v1:被拒 → 作者重交 v2(定稿)→ 甲方接受 v2。此时收口必须可行。
    seedDelivered({ artifactId: "art_v1", author: WK });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_v1", verdict: "reject", note: "要改", createdAt: T0 + 5,
    });
    seedDelivered({ artifactId: "art_v2", author: WK, createdAt: T0 + 6, title: "第二版" });
    // v1 退休(v2 落盘时平台做的,`board_write` 那一段;这里直接照它的效果写)
    db.prepare(`UPDATE artifacts SET status = 'superseded' WHERE id = 'art_v1'`).run();
    openDeliverableSession(db, {
      id: "s_art_v2", projectId: P, deliverableArtifactId: "art_v2", createdAt: T0 + 7,
    });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_v2", verdict: "accept", note: null, createdAt: T0 + 8,
    });

    const tool = TOOL_INDEX.get("project_close");
    if (tool === undefined) throw new Error("project_close 不在工具表里");
    const ctx = {
      db,
      agent: { id: BM, role: "business_manager", specialization: null, displayName: "业务经理" },
      project: loadProjectForAuthz(db, P),
      now: () => T0 + 30,
      newId: (prefix: string) => `${prefix}_${(seq += 1)}`,
    } as unknown as ToolRunContext;
    const r = tool.run({ outcome: "done" }, ctx);
    if (r instanceof Promise) throw new Error("project_close 必须是同步的");
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    expect(getProjectRow(db, P)?.status).toBe("done");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑧ 装配错误:agent / 项目缺失时不许静默
// ══════════════════════════════════════════════════════════════════

describe("⑧ `deliveryAcceptance` 的边界(纯函数,读不到就说读不到)", () => {
  it("没有任何交付物 ⇒ 三个集合都空(而不是「都通过了」)", () => {
    expect(deliveryAcceptance(db, P)).toEqual({
      delivered: [], pending: [], accepted: [], rejected: [],
    });
  });

  it("裁决行指向的工件**不在**已交付集合里 ⇒ 不进任何一个集合(不猜)", () => {
    seedDelivered({ artifactId: "art_x", delivered: false });
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_x", verdict: "accept", note: null, createdAt: T0 + 5,
    });
    const acc = deliveryAcceptance(db, P);
    expect(acc.delivered).toEqual([]);
    expect(acc.accepted).toEqual([]);
    // 行还在库里(它是事实),只是不进「收货」这三个集合 —— 与 HTTP 面拒收
    // `not_delivered` 是同一条判据的两面。
    expect(listDeliveryVerdicts(db, P)).toHaveLength(1);
  });

  it("自检:插入的 agent 真的存在(否则上面那些 owner 断言是空转)", () => {
    expect(loadProjectForAuthz(db, P)?.assignments.length).toBeGreaterThan(0);
    expect(getArtifact(db, "nope")).toBeNull();
  });
});
