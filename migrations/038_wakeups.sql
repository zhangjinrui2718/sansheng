-- 038 · 结构化唤醒(wakeups,2026-11-22):「到点再叫醒我」落成库里的行
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 三生的待办判据全部是「库里的现状」(排空器每 10s 查一次),唯独**时间**表达
-- 不出来:「过两小时再查一次」「每天早上汇报进展」此前没有载体 —— 说了就忘。
-- multica 的 `issue_wakeup`(at / every / cron + 回执去重)是同一件事的成熟
-- 形状;本迁移取它的**时间轴**子集(at 一次性 + every 周期性),cron 与
-- 条件唤醒(--until)先不做,如实记在 KNOWN_GAPS。
--
-- ── 判据铁律(与批次 21 同一条)────────────────────────────────────
--
-- 唤醒只是「到点 ⇒ 多一类待办」,**不携带任何状态**:`collectTodos` 的
-- `wakeup_due` 规则每次重查本表(到期谓词是纯函数),重启后照常补跑。
-- 消费也是库里的终止判据:回合成功结束才写 `status='done'`(at)/
-- `last_fired_at=now`(every)—— at-least-once,与 outbox / client_questions
-- 同一条纪律。
--
-- ── 保险丝(⑤,防「热循环烧 token」)──────────────────────────────
--
--   · **错过折叠**:`every` 的到期谓词是 `now - last_fired_at >= interval`,
--     错过 N 个周期也只产生**一条**待办(multica 同款:只补最新一次)。
--   · **预算闸**:待办 key 稳定(`wakeup_due:<id>`),连续叫不醒由既有的
--     `dispatch_attempts`(默认 3 次)停住 —— 与其他待办同一道闸。
--   · **熔断**:预算烧穿的唤醒不许变僵尸 —— 宿主排空前扫一遍
--     (`cancelExhaustedWakeups`):到顶的 pending 唤醒自动 `cancelled` 并
--     落一条 `⚠️ 定时` 系统消息(multica 的 autopilot 高失败率自动暂停同款)。
--
-- ── 取值域不建 CHECK ────────────────────────────────────────────
--
-- `kind`(at | every)与 `status`(pending | done | cancelled)闭集在读写
-- 两侧的 TS(`storage/repo/wakeups.ts`)—— 与 022 / 030 / 031 / 035 同一条
-- 先例:将来加 cron / 条件唤醒不动 schema。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 一条 `CREATE TABLE` + 一条索引,不写 `IF NOT EXISTS`(撞名响亮报错)。

CREATE TABLE wakeups (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 谁排的这趟(今天只有业务经理持 schedule 能力)。NO ACTION,同 018 的 agent_id。
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
  -- 排这一趟的理由(任务正文会**原样**带上 —— 与排队消息同一条例外:模型
  -- 没有别的地方能读到它)。
  note          TEXT NOT NULL,
  -- at | every —— 闭集在 TS。
  kind          TEXT NOT NULL,
  -- kind='at':到点那一发(毫秒时间戳)。every 时为 NULL。
  at            INTEGER,
  -- kind='every':周期间隔(毫秒,> 0)。at 时为 NULL。
  interval_ms   INTEGER,
  -- pending | done | cancelled —— 闭集在 TS。
  status        TEXT NOT NULL,
  -- 上一次点火(every 的续期锚;错过折叠判据读它)。NULL = 从没点过。
  last_fired_at INTEGER,
  fired_count   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 到期谓词只看 pending 行。
CREATE INDEX idx_wakeups_pending ON wakeups(project_id, status);
