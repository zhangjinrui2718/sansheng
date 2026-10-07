/**
 * C4 · 真机链路(临时数据目录 · 真宿主 · 真 schema · 真排空 · 真工具):
 * 「业务经理拿到交付物 → 平台开一条甲方对话 → 交付那一环有终点」
 *
 * ── 为什么这条必须走真宿主的链路,而不是只测 dispatcher ──────────────
 *
 * C4 的三件事分散在三个文件里,而**它们之间的接线**才是危险面:
 *
 *   ① `migrations/017` 给 `project_sessions` 加两列(真 schema);
 *   ② `dispatcher.ts` 的消费块在 `handover` 回合**成功结束后**建会话
 *      (真排空 → 真回合 → 真工具调用 `tell_client` → 真通道落库);
 *   ③ `ensureSession` 的显式通道(六处调用点:甲方消息 / 播报走 `client`,
 *      工作项执行 / 系统通知走 `internal`)。
 *
 * 单元测试能钉住每一件的**形状**,但钉不住「它们接起来了」—— 而那正是用户在
 * 真机上能看见的部分。所以这一条起的是**真宿主**(`createPlatformHost`,临时数据
 * 目录 + 真实迁移链 + 真 WS 指令 + 真排空循环 + 真 `tell_client` 工具),只把
 * **模型那一步**换成一段确定性的假回合(真机上那一步是 LLM;这里必须可控,
 * 否则断言会变成「看模型今天心情」)。
 *
 * ── 四条断言(与工单里的真机验收逐条对应)──────────────���───────────
 *
 *   1. 新会话被建出来,`channel='client'`、`deliverable_artifact_id` 指向那条交付物;
 *   2. `handover` **不再被重复叫醒**(终止判据成立 —— 这是 017 的核心验收);
 *   3. **回归**:交付对话建立**之后**再跑一个 worker,那条 worker 的消息
 *      **不得**落进交付对话;
 *   4. `ensureSession` 拆掉之后原有调用点行为不变(甲方消息 / 播报 / 业务经理的
 *      回合仍然解析到同一条会话;交付之前不存在第二条对话)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork, markWorkReviewed } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";
import type { SessionMessageView } from "@shared/types/platform.js";

/**
 * 027 起正文住文件:测试里仍从「想写的正文」造出**落点三列** ——
 * sha256 与字节数都是真的(`node:crypto` 现算),不是占位串;正文本身不再进库。
 * 夹具仍然说得出「这件工件的正文是这一句」,只是表达成 (落点, 哈希, 字节数)。
 */
function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

let dataDir: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-c4-deliverable-"));
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 测试夹具无法造出「已配置 provider」的现场");
  }
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [
        {
          id: "prov_test", label: "test", provider: p.id, modelId: model.id,
          apiKey: "test-key-not-used", thinkingLevel: "off",
        },
      ],
      activeProviderId: "prov_test",
      cwd: dataDir,
      personaName: "测试",
    }),
    { mode: 0o600 },
  );
});

afterEach(async () => {
  ws?.close();
  ws = undefined;
  host?.close();
  host = undefined;
  wss?.close();
  wss = undefined;
  await new Promise<void>((r) => (server !== undefined ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到条件成立(或超时)—— 真机链路是异步的,不能靠固定 sleep。 */
async function until(cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/**
 * 假会话:把**模型那一步**换成确定性动作,别的全是真的。
 *
 *   - `handover` 的任务提示词 → 真调一次 `tell_client`(走平台工具 → 真通道 → 真落库)
 *   - 工作项执行(`# 工作项 …`)→ 吐一段正文(它会被 `runWorkInSession` 落进会话)
 *   - 其余(用户消息触发的那次业务经理回合)→ 空转
 */
function makeCreateSession(): CreateSessionFn {
  return async (opts) => {
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => {
      for (const l of [...listeners]) l(ev);
    };
    const customs = opts.customTools ?? [];
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt(payload?: unknown) {
        const text = typeof payload === "string" ? payload : "";
        if (text.includes("把这份交付交代给甲方")) {
          const tell = customs.find((t) => t.name === "tell_client");
          if (tell === undefined) throw new Error("装配错误:业务经理的工具面里没有 tell_client");
          const result = await tell.execute("tc_tell", {
            text: "交付物到了:三条技术路线的对比与选型建议,依据在产出工件里",
          });
          emit({
            type: "tool_execution_start", toolCallId: "tc_tell", toolName: "tell_client",
            args: { text: "交付物到了" },
          } as unknown as AgentSessionEvent);
          emit({
            type: "tool_execution_end", toolCallId: "tc_tell", toolName: "tell_client",
            result, isError: false,
          } as unknown as AgentSessionEvent);
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return;
        }
        if (text.includes("# 工作项 ")) {
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "worker:路线 A 的约束已核对完" },
          } as unknown as AgentSessionEvent);
          // 真 worker 会顺手把工作项收口 —— 否则同一次排空里它会被反复叫醒到预算用尽
          const workId = text.match(/# 工作项 (\S+)/)?.[1];
          const update = customs.find((t) => t.name === "work_update");
          if (workId !== undefined && update !== undefined) {
            await update.execute("tc_done", { workId, status: "done" });
          }
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return;
        }
        // 其余 = 用户消息触发的那次业务经理回合:吐一句话。它按 `client` 通道落库,
        // 落的就是「甲方 ↔ 业务经理」那条对话(交付之后 = 交付对话)。
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "收到,我看看交付物" },
        } as unknown as AgentSessionEvent);
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      async abort() {
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      dispose() { /* 无需清理 */ },
    } as unknown as AgentSession;
    return { session };
  };
}

async function startHost(): Promise<{
  send: (cmd: unknown) => void;
  db: () => Database.Database;
}> {
  host = createPlatformHost({
    dataDir, host: "127.0.0.1", port: 0, version: "test",
    // 定时器挪到一小时之后:这条测试要的是**门铃**这条真路径,不是定时器兜底
    dispatchIntervalMs: 3_600_000,
    createSession: makeCreateSession(),
  });
  const db = host.booted.deps.db;

  server = createServer();
  wss = attachHub(server, host.hub);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });
  return { send: (cmd) => ws!.send(JSON.stringify(cmd)), db: () => db };
}

/** 一个「子树已收口 + 交付物已验收」的现场(项目经理整合完、等业务经理交付)。 */
function seed(db: Database.Database): void {
  // ⚠️ **不在这里插 agent 行。** 宿主启动时已经 `ensureOrg` 过了(2026-10-08 起),
  // 五个角色就在库里 —— 再插一遍会撞 `agents.id` 主键。这不是测试让步:
  // 「组织由平台播种」本来就是生产行为,测试里手插一份反而是**重复了那份事实**。
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: 1,
  });
  for (const id of ["wk", "pm", "bm", "qa"]) addMember(db, "p1", id, 1);
  // 根工作项:done + **已审**(否则先跑的是 `review_work`)
  insertWork(db, {
    id: "R", projectId: "p1", parentWorkId: null, title: "交付:选型建议", goal: "g",
    status: "done", assigneeAgentId: "wk", createdAt: 2, updatedAt: 2,
  });
  markWorkReviewed(db, "R", 3);
  // 整合的产物(策略 ③ 的终止判据)+ 已验收 ⇒ 唯一的待办是 `handover:bm`
  insertArtifact(db, {
    id: "d1", projectId: "p1", conversationId: null, kind: "deliverable", status: "accepted",
    authorAgentId: "pm", title: "选型建议交付物", ...bodyAt("artifacts/d1.md", "三条路线:…"), metadataJson: null,
    createdAt: 4, updatedAt: 4, workId: "R",
  });
}

const sessionsOf = (db: Database.Database) =>
  db.prepare(`SELECT id, channel, deliverable_artifact_id FROM project_sessions ORDER BY id`).all() as Array<{
    id: string; channel: string; deliverable_artifact_id: string | null;
  }>;

const messagesOf = (db: Database.Database, sessionId: string) =>
  db.prepare(
    `SELECT agent_id, kind, content, origin_source, trigger_kind, todo_kind
       FROM session_messages WHERE session_id = ? ORDER BY created_at`,
  )
    .all(sessionId) as Array<{
      agent_id: string | null; kind: string; content: string;
      origin_source: string | null; trigger_kind: string | null; todo_kind: string | null;
    }>;

/**
 * **甲方在交付对话里真正看得见的那几条** —— 与读面 `web/src/lib/data.ts` 的
 * `channelOf` 同一判据:播报封套无条件进,回合封套只有 `user` 触发的那一轮进。
 *
 * ⚠️ 为什么需要它:2026-10-06 之后,业务经理被 `close_finished_project` 之类待办
 * 叫醒的回合**正文会落进交付会话**(会话通道由 `channelForAgent` 决定,那是
 * 既有设计),但读面按封套把它们摘掉 —— 所以「库里有哪些行」与「甲方看到什么」
 * 从此**不是同一件事**。本文件的验收一直是后者。
 */
const clientVisibleOf = (rows: ReturnType<typeof messagesOf>) =>
  rows
    .filter((m) => m.origin_source === "broadcast" || m.trigger_kind === "user")
    .map((m) => `${m.kind}:${m.agent_id ?? "user"}`);

const attemptsOf = (db: Database.Database, key: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_attempts WHERE project_id = 'p1' AND todo_key = ?`)
    .get(key) as { n: number }).n;

/**
 * 业务经理那**一次**交付播报在库里的条数。
 *
 * ⚠️ 这是「`handover` 有没有被重复叫醒」在真机链路上**唯一可信的观察面**。
 * `dispatch_attempts` 不能用:`pruneAttempts` 会在目标行动之后把那一行**清剪**
 * (dispatcher 的消费块跑完,下一次看板里已经没有 `handover:d1` —— 账本按「目标
 * 变了/待办没了」清零),所以事后读它是 0,读不出「叫过几次」。
 * 而播报每被叫醒一次就多写一条(`tell_client` → `clientChannel.tell` → 落库),
 * 所以条数就是被叫醒的次数。
 */
const tellCount = (db: Database.Database) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM session_messages WHERE content LIKE '%交付物到了%'`)
    .get() as { n: number }).n;

describe("C4 真机 · 交付物 → 甲方对话(临时目录 · 真宿主 · 真排空)", () => {
  it("四条:新会话建出来 / `handover` 不再重复叫醒 / worker 不落进它 / 原有调用点行为不变", async () => {
    const h = await startHost();
    const db = h.db();
    seed(db);

    // ── 第 0 步:交付之前,甲方说一句话 → 真回合 + 门铃 + 排空 ──────
    h.send({ type: "send", projectId: "p1", content: "现在交付到什么程度了?" });
    expect(
      await until(() => tellCount(db) === 1),
      "业务经理该被叫醒一次去交付(017 + 消费块第三支):它按提示词播报了一条",
    ).toBe(true);

    // ── 断言 1:新会话建出来,channel='client' + 指向那条交付物 ──────
    expect(await until(() => sessionsOf(db).some((s) => s.channel === "client"))).toBe(true);
    const afterFirst = sessionsOf(db);
    const client = afterFirst.filter((s) => s.channel === "client");
    expect(client, "交付对话有且只有一条").toEqual([
      { id: "s_deliv_d1", channel: "client", deliverable_artifact_id: "d1" },
    ]);
    // 断言 4(前半):交付之前**不存在**第二条会话 —— 甲方消息 / 播报 / 业务经理的
    // 回合都解析到同一条内部会话(拆地雷没有改变行为:从 1 条变 2 条只可能是交付
    // 开的那条,不可能是 `client` 调用点凭空造出来的)
    const internal = afterFirst.filter((s) => s.channel === "internal");
    expect(internal, "内部会话仍然只有一条(项目主会话)").toHaveLength(1);
    const main = internal[0]!.id;
    // 业务经理那次播报(`tell_client`,通道 `client`)落在**项目主会话**里:
    // 交付对话是那个回合**成功结束后**才开的(与 `markWorkReviewed` 同形),
    // 所以交付那一刻说的话还在旧会话里 —— 这是设计的先后顺序,不是漏接线。
    expect(messagesOf(db, main).some((m) => m.agent_id === "bm" && m.content.includes("交付物到了")))
      .toBe(true);
    // ⚠️ 2026-10-06 之前这里断言的是「交付对话**一条消息都没有**」。
    // 现在不再成立 —— 真机终局那条 `close_finished_project` 规则会在交付完成的
    // **下一个 tick** 叫醒业务经理判断收不收口,而他的回合按 `channelForAgent`
    // 落进 client 通道的会话(此时交付对话已经是那一条)。
    //
    // 所以这里改成断言**原来那条真正要验的东西**:交付那一刻说的话**不在**交付
    // 对话里 —— 交付对话是那个回合**成功结束后**才开的。写成「对话里没有那句话」
    // 比「对话为空」准,也不会被下一条规则的多一个回合推翻。
    expect(
      messagesOf(db, "s_deliv_d1").some((m) => m.content.includes("交付物到了")),
      "交付那一刻说的话落在旧会话,不是交付对话(顺序,不是漏接线)",
    ).toBe(false);

    // ── 断言 2:甲方连追两句(两次门铃 ⇒ 两次排空),`handover` 不再被叫醒 ──
    //
    // 判据用**播报条数**:进程里没有定时器(间隔挪到一小时),所以「还会不会被
    // 叫醒」完全由这两次门铃决定;而那条待办的尝试预算是 3 —— 终止判据坏掉的话
    // 这里会看到 2~3 条播报(`tellCount` 会把它们分开数),而不是 1 条。
    for (const q of ["这份交付里第三条路线的依据是什么?", "成本那部分还能再细一点吗?"]) {
      const before = messagesOf(db, "s_deliv_d1").length;
      h.send({ type: "send", projectId: "p1", content: q });
      expect(
        await until(() => messagesOf(db, "s_deliv_d1").length > before),
        "甲方通道的消息必须落进交付对话(而不是又开一条)",
      ).toBe(true);
      // 给「门铃 → 排空」这条 fire-and-forget 的路留出犯错的时间(纯查询,很快)
      await sleep(500);
    }
    expect(tellCount(db), "**终止判据成立 ⇒ 交付只被叫醒一次**(017 的核心验收)").toBe(1);
    // ⚠️ 为什么**不**拿 `dispatch_attempts` 当这个判据:账本只保留**还存在的待办**
    // (`pruneAttempts` 在每次看板重算时清剪),交付办完之后 `handover:d1` 已经不在
    // 看板上 ⇒ 那一行被删掉 ⇒ 事后读到的是 0,读不出「叫过几次」。这里显式钉住
    // 这个事实,免得下一个人拿一个恒为 0 的数当判据。
    expect(attemptsOf(db, "handover:d1"), "目标行动了 ⇒ 账本那一行被清剪(不是「没叫过」)")
      .toBe(0);
    expect(sessionsOf(db).filter((s) => s.channel === "client"), "也没有开出第二条交付对话")
      .toHaveLength(1);
    expect(
      clientVisibleOf(messagesOf(db, "s_deliv_d1")),
      "甲方在交付对话里看到的 = 两句追问 + 两次回话(待办回合的正文按封套摘掉)",
    ).toEqual(["user:user", "assistant:bm", "user:user", "assistant:bm"]);

    // ── 断言 3:交付之后**再跑一个 worker**,它的消息不得落进交付对话 ──
    insertWork(db, {
      id: "w_after", projectId: "p1", parentWorkId: null, title: "补一份路线 C 的成本明细",
      goal: "g", status: "open", assigneeAgentId: "wk", createdAt: 100, updatedAt: 100,
    });
    h.send({ type: "send", projectId: "p1", content: "再补一份路线 C 的成本明细" });
    expect(
      await until(() => messagesOf(db, main).some((m) => m.content.includes("路线 A 的约束已核对完"))),
      "worker 真的跑过一轮(否则「它没落进交付对话」是一句空话)",
    ).toBe(true);
    // 正样本自检 + 断言本体:那条消息在**内部**会话里,而交付对话里一个 worker 字都没有
    expect(messagesOf(db, main).filter((m) => m.agent_id === "wk")).toHaveLength(1);
    expect(
      db.prepare(`SELECT status FROM works WHERE id = 'w_after'`).get(),
      "worker 顺手把工作项收口了(证明这一轮真的跑完了,不是卡在半路)",
    ).toEqual({ status: "done" });
    expect(
      messagesOf(db, "s_deliv_d1").filter((m) => m.agent_id === "wk"),
      "worker 的消息串进交付对话就是 C4 那条地雷复发",
    ).toEqual([]);
    expect(sessionsOf(db).filter((s) => s.channel === "client")).toHaveLength(1);

    // ── 断言 4(后半):HTTP 面上,交付那段往来对甲方可见 ─────────────
    // 「甲方视图」的过滤是前端 A3 的活(`agentId → role → clientFacing`),
    // 这里钉的是**数据到得了那个端点**:业务经理的发言带 `agentId` 与解析好的名字。
    const res = await host!.app.request("/api/projects/p1/messages?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: SessionMessageView[] };
    const bmMsgs = body.messages.filter((m) => m.agentId === "bm");
    expect(bmMsgs.length, "业务经理的发言必须到得了对话页的数据源").toBeGreaterThan(0);
    expect(bmMsgs.every((m) => m.agentName === "业务经理")).toBe(true);
    expect(
      body.messages.some((m) => m.agentId === null && m.kind === "user" && m.content.includes("第三条路线")),
      "甲方自己的追问也在里面",
    ).toBe(true);
    expect(
      body.messages.filter((m) => m.projectId === "p1").length,
      "两个会话的消息在端点上是**按时间归并**的(`views.ts` 的 listProjectMessages)",
    ).toBeGreaterThanOrEqual(6);
    // 真机链路要等真回合一圈圈跑完(vitest 默认 5 秒不够)—— 显式给上界
  }, 30_000);
});
