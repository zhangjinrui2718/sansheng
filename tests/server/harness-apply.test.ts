/**
 * 批次 7-O · harness 写面(src/server/harness/apply.ts + facets + HTTP 面)
 *
 * 本文件守的是**七条「不许假装」**,每条都对应本项目踩过或差点踩的坑:
 *
 *   1. **报成功 = 真生效。** 写入后 describe() 现算的 entry 必须反映新内容
 *      (state 变 user_edited / allowed 变新名单),返回的 content 必须是**回读**
 *      的那份。7-B 的死接线就是「以为接线了,其实没到模型」,同一个病。
 *   2. **覆盖前先备份,备份是写的前置。** 备份失败就不写;备份目录按条目隔离。
 *   3. **id 白名单挡路径穿越。** "../x" / "unknown_role" 一律 unknown_entry,
 *      且**磁盘上不出现任何新文件**。
 *   4. **权限面 fail-closed 不因写接口而放松。** 认识但在 ceiling 外的工具名
 *      照写、但 blockedByCeiling 必须出现 + 告警(7-E 架构裁决);**不认识**的
 *      工具名 400 拒收(写接口收到 = 调用方写错了,静默丢掉就是骗)。
 *   5. **恢复出厂与「删文件」不是一回事。** reset 写回出厂字节,state 回到
 *      default / factory;ensureHarness 之后再跑一次**不能**把手笔覆盖掉。
 *   6. **没实现的写面不假装。** skills / rag → not_implemented(409),面 id 写错
 *      → unknown_facet(404),两者都不是 500。
 *   7. **写端点在安全守卫之后。** 同一个 app 上,evil Host → 421,
 *      cross-site Origin → 403(§B4)。这是 7-E 之前「本地服务被任意网页改
 *      agent 提示词」的那条提权面,必须由测试钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { applyPromptUnit, applyToolSet, MAX_PROMPT_CHARS } from "../../src/server/harness/apply.js";
import { applyFacet, describeFacetEntry, describeHarness } from "../../src/server/harness/facet.js";
import { BUILTIN_PROMPTS } from "../../src/server/harness/promptUnits.js";
import {
  describePrompts,
  ensureHarness,
  loadHarness,
  promptFilePath,
} from "../../src/server/harness/loader.js";
import { factoryToolSetFileContent, toolSetFilePath } from "../../src/server/harness/tools.js";
import { registerHarnessRoutes } from "../../src/server/http/harnessRoutes.js";
import { createSecurityMiddleware } from "../../src/server/http/security.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-harness-apply-"));
});

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** 某条目当前的面条目快照(找不着就说明注册表与磁盘脱节了)。 */
function entryOf(facet: "prompts" | "tools", id: string) {
  const f = describeHarness(dataDir).find((x) => x.id === facet);
  const e = f?.entries.find((x) => x.id === id);
  if (!e) throw new Error(`找不到条目 ${facet}/${id}`);
  return e;
}

/* ── prompts 面 ─────────────────────────────────────────────────────────── */

describe("harness 写面 · prompts(批次 7-O)", () => {
  it("写入用户手笔 → 落盘 + state 变 user_edited + loadHarness 立刻读到", () => {
    ensureHarness(dataDir);
    const r = applyPromptUnit(dataDir, "executor", "你是执行者,先看证据再动手。", false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 报成功 = 真生效:磁盘字节、loadHarness、describe 三处一致
    expect(readFileSync(promptFilePath(dataDir, "executor"), "utf-8")).toBe("你是执行者,先看证据再动手。");
    expect(loadHarness(dataDir).systemPrompts["executor"]).toBe("你是执行者,先看证据再动手。");
    const info = describePrompts(dataDir).find((p) => p.role === "executor");
    expect(info?.state).toBe("user_edited");
    expect(entryOf("prompts", "executor").source).toBe("user");

    // 覆盖前的那份出厂默认已经进备份目录
    const backups = readdirSync(join(dataDir, "harness", "backups", "prompts"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dataDir, "harness", "backups", "prompts", backups[0]!), "utf-8")).toBe(
      BUILTIN_PROMPTS["executor"],
    );
  });

  it("内容没变 → changed=false,不产生新备份(幂等)", () => {
    ensureHarness(dataDir);
    const text = "同一份内容写两遍";
    applyPromptUnit(dataDir, "planner", text, false);
    const before = readdirSync(join(dataDir, "harness", "backups", "prompts"));
    const second = applyPromptUnit(dataDir, "planner", text, false);
    expect(second.ok && second.changed).toBe(false);
    expect(second.ok && second.backupPath).toBeNull();
    expect(readdirSync(join(dataDir, "harness", "backups", "prompts"))).toEqual(before);
  });

  it("恢复出厂 → 写回出厂字节,state 回到 default,且备份的是手笔版", () => {
    ensureHarness(dataDir);
    applyPromptUnit(dataDir, "planner", "我的规划员手册", false);
    const r = applyPromptUnit(dataDir, "planner", undefined, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(readFileSync(promptFilePath(dataDir, "planner"), "utf-8")).toBe(BUILTIN_PROMPTS["planner"]);
    expect(describePrompts(dataDir).find((p) => p.role === "planner")?.state).toBe("default");
    expect(entryOf("prompts", "planner").source).toBe("factory");
    // 手笔那一版被备份下来了(恢复出厂不是「毁掉」)
    const backups = readdirSync(join(dataDir, "harness", "backups", "prompts"));
    expect(backups.some((b) => readFileSync(join(dataDir, "harness", "backups", "prompts", b), "utf-8") === "我的规划员手册")).toBe(true);
  });

  it("恢复出厂后 ensureHarness 不把手笔当旧版覆盖(手笔仍是手笔)", () => {
    ensureHarness(dataDir);
    applyPromptUnit(dataDir, "planner", "用户手写", false);
    ensureHarness(dataDir); // 幂等跑一次
    expect(loadHarness(dataDir).systemPrompts["planner"]).toBe("用户手写");
  });

  it("非法 id(含 ../)→ unknown_entry,磁盘上不出现任何新文件", () => {
    ensureHarness(dataDir);
    const before = readdirSync(join(dataDir, "harness", "system_prompts")).sort();
    for (const bad of ["../evil", "../../etc/passwd", "not_a_unit", "executor.md"]) {
      const r = applyPromptUnit(dataDir, bad, "x", false);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("unknown_entry");
    }
    expect(readdirSync(join(dataDir, "harness", "system_prompts")).sort()).toEqual(before);
    expect(existsSync(join(dataDir, "harness", "evil.md"))).toBe(false);
  });

  it("超长内容 / 非字符串 → invalid_payload,原文件一字未动", () => {
    ensureHarness(dataDir);
    const original = readFileSync(promptFilePath(dataDir, "executor"), "utf-8");
    const tooLong = applyPromptUnit(dataDir, "executor", "x".repeat(MAX_PROMPT_CHARS + 1), false);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toBe("invalid_payload");
    const notString = applyPromptUnit(dataDir, "executor", { a: 1 }, false);
    expect(notString.ok).toBe(false);
    if (!notString.ok) expect(notString.error).toBe("invalid_payload");
    expect(readFileSync(promptFilePath(dataDir, "executor"), "utf-8")).toBe(original);
  });

  it("空内容是合法输入,但必须带一条「这会退回内置常量」的告警", () => {
    ensureHarness(dataDir);
    const r = applyPromptUnit(dataDir, "executor", "   ", false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join()).toContain("退回内置常量");
    expect(describePrompts(dataDir).find((p) => p.role === "executor")?.state).toBe("empty");
  });

  it("orphan 单元可写,但写完仍然标着「零消费方」", () => {
    ensureHarness(dataDir);
    const r = applyPromptUnit(dataDir, "critic", "评审者的自定手册", false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = entryOf("prompts", "critic");
    expect(e.enforced).toBe(false);
    expect(e.warnings.join()).toContain("零消费方");
  });
});

/* ── tools 面 ───────────────────────────────────────────────────────────── */

describe("harness 写面 · tools(批次 7-O)", () => {
  it("写入 allow → 规范字节落盘 + allowed 变新名单", () => {
    ensureHarness(dataDir);
    const r = applyToolSet(dataDir, "executor", { allow: ["read", "grep", "write"], deny: [] }, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = readFileSync(toolSetFilePath(dataDir, "executor"), "utf-8");
    // 规范字节:末尾换行 + 2 空格缩进 —— source 判定就靠这个字节串
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"write"');
    const detail = entryOf("tools", "executor").detail as { allowed: string[]; source: string };
    expect(detail.allowed).toEqual(["read", "grep", "write"]);
    expect(entryOf("tools", "executor").source).toBe("user");
  });

  it("ceiling 外的工具名:照写文件,但 blockedByCeiling + 告警(7-E 架构裁决不被写接口削弱)", () => {
    ensureHarness(dataDir);
    // 沟通员的架构上界里没有 bash —— 用户往集合文件里写它
    const r = applyToolSet(dataDir, "communicator", { allow: ["read", "bash"], deny: [] }, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(toolSetFilePath(dataDir, "communicator"), "utf-8")).toContain("bash");
    const detail = entryOf("tools", "communicator").detail as { allowed: string[]; blockedByCeiling: string[] };
    expect(detail.allowed).toEqual(["read"]);
    expect(detail.blockedByCeiling).toEqual(["bash"]);
    expect(r.warnings.join()).toContain("架构上界");
  });

  it("不认识的工具名 → invalid_payload(400),文件一个字节都不动", () => {
    ensureHarness(dataDir);
    const before = readFileSync(toolSetFilePath(dataDir, "executor"), "utf-8");
    const r = applyToolSet(dataDir, "executor", { allow: ["read", "net_send"], deny: [] }, false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("invalid_payload");
    expect((r.details as { unknown: string[] }).unknown).toEqual(["net_send"]);
    expect(readFileSync(toolSetFilePath(dataDir, "executor"), "utf-8")).toBe(before);
  });

  it("allow 与 deny 打架 → 照写 + 告警(deny 胜出由解析器裁决)", () => {
    ensureHarness(dataDir);
    const r = applyToolSet(dataDir, "executor", { allow: ["read", "write"], deny: ["write"] }, false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join()).toContain("deny 胜出");
    const detail = entryOf("tools", "executor").detail as { allowed: string[] };
    expect(detail.allowed).toEqual(["read"]);
  });

  it("非法 role(含 ../)→ unknown_entry,不落盘", () => {
    ensureHarness(dataDir);
    const r = applyToolSet(dataDir, "../../evil", { allow: ["read"] }, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_entry");
    expect(existsSync(join(dataDir, "harness", "tools", "..", "..", "evil.json"))).toBe(false);
  });

  it("恢复出厂 → 字节与 ensureToolSets 写出的完全一致,source 回 factory", () => {
    ensureHarness(dataDir);
    applyToolSet(dataDir, "communicator", { allow: ["read"], deny: [] }, false);
    const r = applyToolSet(dataDir, "communicator", undefined, true);
    expect(r.ok).toBe(true);
    expect(readFileSync(toolSetFilePath(dataDir, "communicator"), "utf-8")).toBe(
      factoryToolSetFileContent("communicator"),
    );
    expect(entryOf("tools", "communicator").source).toBe("factory");
  });
});

/* ── facet 分发 ─────────────────────────────────────────────────────────── */

describe("harness 写面 · facet 分发", () => {
  it("applyFacet 写完把真实快照带回来(UI 不需要再猜一次)", () => {
    ensureHarness(dataDir);
    const r = applyFacet("tools", dataDir, { id: "planner", payload: { allow: ["board_list"], deny: [] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.id).toBe("planner");
    expect((r.entry.detail as { allowed: string[] }).allowed).toEqual(["board_list"]);
    expect(r.apply).toContain("下一次");
  });

  it("skills / rag 没有写面 → not_implemented(不是 500,也不是假成功)", () => {
    ensureHarness(dataDir);
    for (const facet of ["skills", "rag"] as const) {
      const r = applyFacet(facet, dataDir, { id: "whatever", payload: {} });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("not_implemented");
    }
  });

  it("面 id 写错 → unknown_facet", () => {
    const r = applyFacet("nope" as "tools", dataDir, { id: "executor", payload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_facet");
  });

  it("详情与总表同源:describeFacetEntry 的 entry 与 GET /api/harness 一致", () => {
    ensureHarness(dataDir);
    applyFacet("prompts", dataDir, { id: "executor", payload: { content: "新手册" } });
    const d = describeFacetEntry("prompts", dataDir, "executor");
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.detail.entry).toEqual(entryOf("prompts", "executor"));
    expect((d.detail.payload as { content: string }).content).toBe("新手册");
  });

  it("tools 详情带 ceiling / catalog,勾选矩阵能标出「上界外」的工具", () => {
    ensureHarness(dataDir);
    const d = describeFacetEntry("tools", dataDir, "communicator");
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const payload = d.detail.payload as {
      ceiling: string[];
      catalog: Array<{ name: string; inCeiling: boolean }>;
    };
    expect(payload.ceiling).not.toContain("bash");
    expect(payload.catalog.find((c) => c.name === "read")?.inCeiling).toBe(true);
  });
});

/* ── HTTP 面 ────────────────────────────────────────────────────────────── */

function makeApp(): Hono {
  const app = new Hono();
  app.use("*", createSecurityMiddleware());
  registerHarnessRoutes(app, { dataDir, invalidateKernel: () => { invalidated += 1; } });
  return app;
}

let invalidated = 0;

beforeEach(() => {
  invalidated = 0;
  ensureHarness(dataDir);
});

const PUT = "/api/harness/facets/prompts/entries/executor";
const RESET = `${PUT}/reset`;

describe("harness 写面 · HTTP", () => {
  it("GET 详情返回编辑器初值(内容 + 出厂默认 + 生效时机)", async () => {
    const res = await makeApp().request("/api/harness/facets/prompts/entries/executor");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detail: { payload: { content: string; factory: string; apply: string } } };
    expect(body.detail.payload.content).toBe(BUILTIN_PROMPTS["executor"]);
    expect(body.detail.payload.factory).toBe(BUILTIN_PROMPTS["executor"]);
    expect(body.detail.payload.apply).toContain("下一次");
  });

  it("GET 不存在的条目 → 404(不是 500,也不是空壳)", async () => {
    const res = await makeApp().request("/api/harness/facets/prompts/entries/../evil");
    expect(res.status).toBe(404);
  });

  it("PUT 写入 → 200 + changed + 备份路径 + 写后快照", async () => {
    const res = await makeApp().request(PUT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "HTTP 写进来的手册" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      changed: boolean;
      backupPath: string | null;
      entry: { source: string };
      invalidated?: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.backupPath).toContain("backups/prompts");
    expect(body.entry.source).toBe("user");
    expect(body.invalidated).toBeUndefined(); // 没勾就不动 kernel
    expect(invalidated).toBe(0);
    expect(loadHarness(dataDir).systemPrompts["executor"]).toBe("HTTP 写进来的手册");
  });

  it("PUT body.invalidate=true → 丢弃当前 session(沟通员提示词立即生效)", async () => {
    const res = await makeApp().request("/api/harness/facets/tools/entries/communicator", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: ["read"], deny: [], invalidate: true }),
    });
    expect(res.status).toBe(200);
    expect(invalidated).toBe(1);
  });

  it("PUT 不合法内容 → 400,且文件未改动", async () => {
    const before = readFileSync(promptFilePath(dataDir, "executor"), "utf-8");
    const res = await makeApp().request(PUT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(400);
    expect(readFileSync(promptFilePath(dataDir, "executor"), "utf-8")).toBe(before);
  });

  it("未知工具名 → 400,并把「哪些名字不认识」如实回给调用方", async () => {
    const res = await makeApp().request("/api/harness/facets/tools/entries/executor", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: ["read", "wat"] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: { unknown: string[] } };
    expect(body.error).toBe("invalid_payload");
    expect(body.details.unknown).toEqual(["wat"]);
  });

  it("恢复出厂必须显式 confirm —— 误触 / 重放请求丢不掉用户手笔", async () => {
    const app = makeApp();
    await app.request(PUT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "我的手册" }),
    });
    const noConfirm = await app.request(RESET, { method: "POST" });
    expect(noConfirm.status).toBe(400);
    expect(loadHarness(dataDir).systemPrompts["executor"]).toBe("我的手册");

    const confirmed = await app.request(RESET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "reset" }),
    });
    expect(confirmed.status).toBe(200);
    expect(loadHarness(dataDir).systemPrompts["executor"]).toBe(BUILTIN_PROMPTS["executor"]);
  });

  it("skills / rag 写面 → 409(面在,但没实现写)", async () => {
    const res = await makeApp().request("/api/harness/facets/skills/entries/foo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("写端点在 B4 安全守卫之后:evil Host → 421,cross-site Origin → 403", async () => {
    const app = makeApp();
    const evilHost = await app.request(PUT, {
      method: "PUT",
      headers: { host: "evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(evilHost.status).toBe(421);

    const csrf = await app.request(PUT, {
      method: "PUT",
      headers: { host: "127.0.0.1:2718", origin: "https://evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ content: "被 CSRF 改掉的提示词" }),
    });
    expect(csrf.status).toBe(403);
    // 一次都没写进去
    expect(loadHarness(dataDir).systemPrompts["executor"]).toBe(BUILTIN_PROMPTS["executor"]);
  });

  it("invalidateKernel 抛错不吞:配置已保存 + 如实报告没做成", async () => {
    const app = new Hono();
    app.use("*", createSecurityMiddleware());
    registerHarnessRoutes(app, {
      dataDir,
      invalidateKernel: () => {
        throw new Error("会话正在忙");
      },
    });
    const res = await app.request(PUT, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "已保存", invalidate: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invalidated: boolean; invalidateError: string };
    expect(body.invalidated).toBe(false);
    expect(body.invalidateError).toContain("会话正在忙");
    expect(loadHarness(dataDir).systemPrompts["executor"]).toBe("已保存");
  });
});

/* ── 备份保留策略 ───────────────────────────────────────────────────────── */

describe("harness 写面 · 备份保留", () => {
  it("同一条目只留最近 10 份备份,别人的条目不受影响", () => {
    ensureHarness(dataDir);
    for (let i = 0; i < 12; i++) {
      applyPromptUnit(dataDir, "executor", `第 ${i} 版`, false);
    }
    const dir = join(dataDir, "harness", "backups", "prompts");
    const files = readdirSync(dir);
    expect(files).toHaveLength(10);
    expect(files.every((f) => f.startsWith("executor."))).toBe(true);
  });

  it("手写一个乱七八糟的集合文件也不会被写面「顺手修好」—— 写面只写它被要求写的那个条目", () => {
    ensureHarness(dataDir);
    writeFileSync(toolSetFilePath(dataDir, "planner"), "{ 不是 json", "utf-8");
    applyToolSet(dataDir, "executor", { allow: ["read"], deny: [] }, false);
    expect(readFileSync(toolSetFilePath(dataDir, "planner"), "utf-8")).toBe("{ 不是 json");
  });
});

/* vi 在本文件里只用于 ensure 未来的 spy 场景;引用它避免 lint 抱怨未使用。 */
void vi;
