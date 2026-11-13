/**
 * 供应商切换历史(`GET /api/diagnostics/provider-failover`)· 审计聚合读面
 *
 * ── 这条读面**不是**什么 ─────────────────────────────────────────
 *
 * 它不是结构化遥测:数据源是 `session_messages` 里 `kind='system'`、首行前缀
 * `⚠️ 供应商` 的平台通知(生产者是 `host/serve.ts` 的
 * `announceProviderFailover` / `announceProviderBrakePaused`,全库只有这两处
 * 写这个前缀)。「降级没有结构化落库」在 About 页「已知不实之处」里如实记着,
 * 这条读面**不改变**那条事实 —— 它只是给已有痕迹一个读者。
 *
 * 这里钉住四件事(全部来自真实生产者的文案,逐字取自 `serve.ts`):
 *   · **过滤**:非 `⚠️ 供应商` 的 system 通知(工作区告警 / 停止推进)与
 *     user / assistant 消息都不进来 —— 前缀是唯一判据;
 *   · **排序**:新的在前(`created_at DESC`,同一毫秒用 `id` 做第二键);
 *   · **kind 派生**:「已从 … 切到 …」⇒ failover、「已暂停」⇒ brake、
 *     都不是 ⇒ other(不丢行,但现役生产者只有前两种);
 *   · **limit**:HTTP 面恒取最近 20 条(`PROVIDER_NOTICE_LIMIT`),
 *     summary 只取正文**首行**(续行不进读面)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import {
  appendSessionMessage, insertSession, listProviderNotices, PROVIDER_NOTICE_LIMIT,
} from "../../src/platform/storage/repo/sessions.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import { providerNoticeKindOf } from "../../src/platform/transport/views.js";
import type { ProviderFailoverResponse } from "@shared/types/platform.js";

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;

const PA = "p-alpha";
const PB = "p-beta";

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  insertProject(db, {
    id: PA, name: "项目甲", client: "甲方", goal: "做甲",
    status: "active", createdAt: clock,
  });
  clock += 1;
  insertProject(db, {
    id: PB, name: "项目乙", client: "甲方", goal: "做乙",
    status: "active", createdAt: clock,
  });
  clock += 1;
  insertSession(db, { id: "s-internal-a", projectId: PA, createdAt: clock });
  clock += 1;
  insertSession(db, { id: "s-internal-b", projectId: PB, createdAt: clock });
});

afterEach(() => {
  db.close();
});

/** 落一条平台通知(`agentId: null` + `originSource: null` —— 与两个 announce 一致)。 */
function systemNotice(content: string, sessionId = "s-internal-a"): void {
  seq += 1;
  clock += 1;
  appendSessionMessage(db, {
    id: `m${seq}`, sessionId, agentId: null, kind: "system", content, createdAt: clock,
    originSource: null, triggerKind: null,
  });
}

/** 落一条非 system 消息(kind 维度的负样本)。 */
function plainMessage(kind: "user" | "assistant", content: string): void {
  seq += 1;
  clock += 1;
  appendSessionMessage(db, {
    id: `m${seq}`, sessionId: "s-internal-a", agentId: null, kind, content, createdAt: clock,
    originSource: null, triggerKind: null,
  });
}

// 逐字取自 `host/serve.ts` 的两个 announce(插值换成了具体值)。
const FAILOVER_A =
  "⚠️ 供应商:已从 minimax-main 切到备用 provider deepseek-backup(原因:429 rate_limit)。这条工作项会被重新派发(不记失败)。";
const FAILOVER_B =
  "⚠️ 供应商:已从 deepseek-backup 切到备用 provider minimax-main(原因:network error)。这条工作项会被重新派发(不记失败)。";
const BRAKE_MULTILINE =
  "⚠️ 供应商:连续遇到 provider 故障(限流/断网类),自动派发已暂停,预计约 120 秒后自动重试(provider 恢复后无需人工干预)。\n第二行是给项目页「组织运行态」的续行,不该进诊断读面。";

function app(over?: Partial<HttpDeps>) {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/provider-failover-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/provider-failover-test", factoryDir: "/tmp/provider-failover-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  };
  return createPlatformApp(deps);
}

describe("仓储层 listProviderNotices:前缀过滤 + 新的在前", () => {
  it("只取 `⚠️ 供应商` 前缀的 system 行;其它 system 通知与 user/assistant 不进来", () => {
    systemNotice(FAILOVER_A);
    plainMessage("user", "甲方说:继续");
    plainMessage("assistant", "业务经理:好的");
    // 同为 system、前缀不同 —— 平台的另外两类通知,不该被当成供应商事件。
    systemNotice("⚠️ 工作区:提交失败(2 个文件没进版本库)");
    systemNotice("停止推进:预算用尽(3 次派发没有叫醒任何人)");
    systemNotice(FAILOVER_B, "s-internal-b");
    systemNotice(BRAKE_MULTILINE);

    const rows = listProviderNotices(db);
    expect(rows.map((r) => r.content)).toEqual([BRAKE_MULTILINE, FAILOVER_B, FAILOVER_A]);
    // projectId 由 join 带出,跨项目各归各的
    expect(rows[1].projectId).toBe(PB);
    expect(rows[2].projectId).toBe(PA);
    expect(rows[0].projectId).toBe(PA);
  });

  it("limit 生效:给了更小的值就取最近那几条", () => {
    systemNotice(FAILOVER_A);
    systemNotice(BRAKE_MULTILINE);
    systemNotice(FAILOVER_B, "s-internal-b");

    const one = listProviderNotices(db, 1);
    expect(one).toHaveLength(1);
    expect(one[0].content).toBe(FAILOVER_B); // 最新的那条
  });
});

describe("views 层 providerNoticeKindOf:从首行派生 kind", () => {
  it("failover / brake / other 三档,判据是首行里的固定短语", () => {
    expect(providerNoticeKindOf(FAILOVER_A)).toBe("failover");
    expect(providerNoticeKindOf(BRAKE_MULTILINE.split("\n")[0])).toBe("brake");
    // 都不是 ⇒ other,**不丢行**(丢行 = 把真实发生的故障藏起来)
    expect(providerNoticeKindOf("⚠️ 供应商:将来可能出现的第三种措辞")).toBe("other");
  });
});

describe("HTTP GET /api/diagnostics/provider-failover", () => {
  it("返回过滤 + 排序 + kind 派生 + 首行摘要,projectId 由 join 带出", async () => {
    systemNotice(FAILOVER_A);
    systemNotice("⚠️ 工作区:提交失败"); // 必须被滤掉
    systemNotice(FAILOVER_B, "s-internal-b");
    systemNotice(BRAKE_MULTILINE);

    const res = await app().request("/api/diagnostics/provider-failover");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderFailoverResponse;

    expect(body.entries).toHaveLength(3);
    // 新的在前
    expect(body.entries.map((e) => e.kind)).toEqual(["brake", "failover", "failover"]);
    // summary 只取首行 —— 续行留在项目页「组织运行态」的正文里
    expect(body.entries[0].summary).toBe(BRAKE_MULTILINE.split("\n")[0]);
    expect(body.entries[0].summary).not.toContain("第二行");
    expect(body.entries[0].sessionId).toBe("s-internal-a");
    expect(body.entries[0].projectId).toBe(PA);
    expect(body.entries[1].projectId).toBe(PB);
    expect(body.entries[1].summary).toBe(FAILOVER_B);
    // createdAt 是数字时间戳,随排序单调不增
    expect(body.entries[0].createdAt).toBeGreaterThanOrEqual(body.entries[1].createdAt);
  });

  it("没有供应商通知 ⇒ 空 entries(200,不是错误)", async () => {
    plainMessage("user", "甲方说:开始");
    systemNotice("⚠️ 工作区:提交失败");

    const res = await app().request("/api/diagnostics/provider-failover");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderFailoverResponse;
    expect(body.entries).toEqual([]);
  });

  it("HTTP 面恒取最近 20 条(`PROVIDER_NOTICE_LIMIT`)", async () => {
    expect(PROVIDER_NOTICE_LIMIT).toBe(20);
    for (let i = 0; i < 22; i += 1) {
      systemNotice(`⚠️ 供应商:已从 a${i} 切到备用 provider b${i}(原因:测试)。`);
    }
    const res = await app().request("/api/diagnostics/provider-failover");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProviderFailoverResponse;
    expect(body.entries).toHaveLength(20);
    // 取的是**最近** 20 条,不是最早 20 条(LIMIT 切尾巴,与 listSessionMessages 同一条纪律)
    expect(body.entries[0].summary).toContain("a21");
    expect(body.entries[19].summary).toContain("a2");
    expect(body.entries[19].summary).not.toContain("a1");
  });
});
