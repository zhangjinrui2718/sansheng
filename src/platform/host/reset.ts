/**
 * 平台 · 数据重置(取代旧系统的「删文件」法)
 *
 * ── 为什么不照搬旧做法 ──────────────────────────────────────────
 *
 * 旧系统的 `POST /api/reset` 是**删文件**(`sansheng.db` + `-wal` + `-shm`),
 * 理由是:上层的 kernel / storage / ws 三者的生命周期纠缠在一起,关连接再重开
 * 比逐个清表更容易写对。
 *
 * 新架构下**没有这个理由**:仓储是纯函数(每个函数自己拿 db),schema 由
 * migration 拥有,数据只是数据。所以重置 = **把平台表的行删干净** ——
 *
 *   - 不必关连接、不必重开、不必重建宿主、WebSocket 不断
 *   - 不会出现「删文件成功但进程还握着旧句柄」这类只有真机才暴露的问题
 *   - schema 保持不变(migration 账本 `schema_version` 不动 —— 重置数据不是
 *     回退 schema)
 *
 * 用户 2026-10-23 的指令是「一切以最新的为准,有冲突删掉老的写新的」,
 * 这条正是那个原则的落点。
 *
 * ── 那条守卫为什么必须有(以及它曾经**缺失**的真实代价)──────────
 *
 * 表清单是**硬编码**的。将来加一张表而忘了加进这里,重置就会**静默漏掉它** ——
 * 用户以为清干净了,实际上有一张表还留着旧数据。
 *
 * ⚠️ **2026-10-05 实测:这条守卫此前只写在注释里,而那行注释是假的。**
 * 本文件曾经声称「有一个测试断言清单覆盖所有平台表(见
 * `tests/platform/reset.test.ts`)」,而 `git log --all -- tests/platform/reset.test.ts`
 * **一条记录都没有** —— 那个测试从来没有被提交过。代价是在真机上量出来的:
 *
 *   - migration 013 的 `dispatch_events` / `dispatch_attempts` 与 018 的
 *     `turn_usage` **都不在清单里**(013 / 018 都在本文件写完之后才加);
 *   - `turn_usage.agent_id → agents(id)` 是 **NO ACTION** ⇒ 库里有 usage 行时,
 *     删到 `agents` 那一步 `FOREIGN KEY constraint failed`;
 *   - 而重置**在一个事务里**做 ⇒ **整体回滚** ⇒ 一行都没清,接口 500
 *     ("Internal Server Error",连一句可读的原因都没有)。
 *
 * ⇒ 守卫现在是**真的**:`tests/platform/reset.test.ts` 既做覆盖差集(漏一张表就红),
 *   也做「在真形状的库上真的清干净」的行为回归(含 `turn_usage`,即上面那次事故的形状)。
 *   **注释里声称存在的测试,必须能被 `ls` 到** —— 与 AGENTS.md「有声明没读者」同源,
 *   只是这次缺的是**守卫**。
 */
import type Database from "better-sqlite3";

/**
 * 平台数据表,**按外键安全顺序**(子先于父)。
 *
 * 注意不含:
 *   - `schema_version`  —— migration 账本,重置数据不回退 schema
 *   - `fragments_vec*`   —— 旧系统的向量索引(属清场删除范围)
 *   - 6 张旧表(agent_states / blackboards / conversations / fragments /
 *     messages / user_profile)—— 同上
 */
export const PLATFORM_DATA_TABLES: readonly string[] = [
  // BC6 排空器状态(migration 013)+ 回合用量(migration 018)
  //
  // ⚠️ 这三张是**后补进来的**(2026-10-05):它们此前不在清单里,而 013 / 018
  // 都比本文件晚 ⇒ 真机上「重置」在有 usage 数据的库上直接 500(见文件头那段)。
  // 三张都引 `projects`,后两张还引 `works` / `agents` ⇒ 必须排在它们的父表之前。
  "dispatch_events",
  "dispatch_attempts",
  "turn_usage",
  // BC1 项目与工作
  "work_deps",
  "works",
  "project_assignments",
  "projects",
  // BC3 黑板
  "artifact_links",
  "artifacts",
  // BC4 阻塞与变更
  "blocker_blocks",
  "blockers",
  "change_affects",
  "change_requests",
  // BC2 协作
  "meeting_participants",
  "meetings",
  "asks",
  "session_messages",
  "project_sessions",
  // BC7 记忆
  "memory_fragments",
  "memory_profile",
  // BC0 最后删 —— 其他表都引用 agents
  "agents",
];

/** 不属于本清单、但也不该被重置的表(守卫测试据此判断)。 */
export const NON_RESET_TABLES: readonly string[] = ["schema_version"];

export interface ResetReport {
  readonly cleared: Array<{ table: string; rows: number }>;
  readonly totalRows: number;
}

/**
 * 清空全部平台数据。
 *
 * **在一个事务里做** —— 中途失败会留下「一半项目没了、一半还在」的状态,
 * 那比不清更糟(因为它看起来像清过了)。
 */
export function resetPlatformData(db: Database.Database): ResetReport {
  const cleared: Array<{ table: string; rows: number }> = [];
  let totalRows = 0;

  const run = db.transaction(() => {
    for (const table of PLATFORM_DATA_TABLES) {
      // 表不存在就跳过(理论上不该发生;但重置不该因为一张表的缺失而全盘失败 ——
      // 那会让用户卡在「清不掉」的状态里)。守卫测试负责保证清单是对的。
      const exists = db
        .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table) as { x: number } | undefined;
      if (exists === undefined) continue;

      const before = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      db.prepare(`DELETE FROM ${table}`).run();
      cleared.push({ table, rows: before.n });
      totalRows += before.n;
    }
  });

  run();
  return { cleared, totalRows };
}
