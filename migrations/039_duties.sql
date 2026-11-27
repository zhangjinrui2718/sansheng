-- 039 · 职责(duties / duty_runs,2026-11-27):「自己到点找活干」落成库里的行
--
-- ── 它补的是什么 ────────────────────────────────────────────────
--
-- 三生此前的每一步都由甲方开口触发:立项要他谈、计划要他点「确认开工」、
-- 进展要他问。系统里没有任何一行能表达「这是一摊常设的事,到点你该去做」——
-- `wakeups`(038)只能排一次性或按间隔的唤醒,绑死在某个项目上,也没有「每天几点」。
-- 本迁移把**职责**落成两张表:
--
--   · `duties`   —— 一条常设的事:目标、节奏、边界、产出形态、下一次该开工的时刻;
--   · `duty_runs`—— 每一轮功课的记录(开工时列的功课、收工时写的自省)。
--
-- **一条职责 = 一个长期项目 + 一条职责记录**(`duties.project_id` 一对一指向那个
-- 项目)。工作项、工件、知识语料、对话线全部复用项目已有的那一套,不另造一份。
--
-- ── 判据铁律(与批次 21 同一条)────────────────────────────────────
--
-- 「该不该开工」是纯查询:排空器每次 tick 读 `status` / `next_due_at` 与
-- 有没有未收工的一轮,不携带任何跨排空状态。**下一次的时刻是算出来存进库的**
-- (`next_due_at`,按排定点累加,不按实际收工时间 —— 后者会漂),进程当时不在,
-- 下次醒来照样补做一轮。
--
-- ── 取值域不建 CHECK ────────────────────────────────────────────
--
-- `cadence_kind`(daily | weekly | hourly)、`status`(active | paused)、
-- `duty_runs.status`(open | done)闭集在读写两侧的 TS(`storage/repo/duties.ts`)——
-- 与 022 / 030 / 031 / 035 / 038 同一条先例:将来加节奏不动 schema。
--
-- ── 本迁移只做加法 ──────────────────────────────────────────────
--
-- 两条 `CREATE TABLE` + 两条索引,不写 `IF NOT EXISTS`(撞名响亮报错)。
-- 外键:`duties.project_id → projects`(CASCADE)、`duty_runs.duty_id → duties`
-- (CASCADE)—— 都排在 `host/reset.ts` 清库清单里父表之前。

CREATE TABLE duties (
  id            TEXT PRIMARY KEY,
  -- 这条职责的工作间:一个长期保持 active 的项目(与职责一对一)。
  project_id    TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- 目标:什么算做好了(「大处」—— 每一轮的功课只朝它迈一小步)。
  goal          TEXT NOT NULL,
  -- 边界:必须先问甲方的事。**原样**带给每一轮的任务正文(模型没有别处能读到它)。
  boundaries    TEXT NOT NULL DEFAULT '',
  -- daily | weekly | hourly —— 闭集在 TS。
  cadence_kind  TEXT NOT NULL,
  -- daily / weekly 的本地时刻 "HH:MM";hourly 时为 NULL。
  cadence_at    TEXT,
  -- weekly:星期几(0 = 周日 … 6 = 周六,与 JS 的 getDay 同一套);其余为 NULL。
  cadence_weekday INTEGER,
  -- hourly:每隔几小时(>= 1);其余为 NULL。
  cadence_hours INTEGER,
  -- 产出形态:0 = 例行产出(日报,不走交付物);1 = 正式交付物(要走验收)。
  formal        INTEGER NOT NULL DEFAULT 0,
  -- active | paused —— 闭集在 TS。paused 时 next_due_at 为 NULL。
  status        TEXT NOT NULL,
  -- 下一次该开工的时刻(毫秒)。**算出来存进库的**,见文件头「判据铁律」。
  next_due_at   INTEGER,
  -- 最近一轮开工的时刻;NULL = 从没开过工。
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 到期谓词只看启用的职责。
CREATE INDEX idx_duties_due ON duties(status, next_due_at);

CREATE TABLE duty_runs (
  id            TEXT PRIMARY KEY,
  duty_id       TEXT NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
  -- 这一轮服务的是**哪个排定点**。与 started_at 分开存:晚开工时两者不同,
  -- 日报里「比排定时间晚了多久」读的就是这两个数的差。
  scheduled_for INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  -- open | done —— 闭集在 TS。done 是终态(已收工的记录不可改)。
  status        TEXT NOT NULL,
  -- 功课:JSON 数组 [{ title, criterion, done, note }]。开课时由模型写入。
  steps         TEXT NOT NULL,
  -- 自省六项(收工时由模型写入;open 时全为 NULL):
  done_summary  TEXT,
  not_done      TEXT,
  -- 原因在自己哪一步。这一轮里有失败时,收工工具要求它非空。
  cause         TEXT,
  next_change   TEXT,
  gaps          TEXT,
  learned       TEXT,
  -- 这一轮窗口内平台查到的失败:JSON 数组 [{ kind, id, title }]。
  failures      TEXT NOT NULL DEFAULT '[]'
);

-- 「今天开过几轮」与「上一轮是什么」都按 (duty_id, started_at) 查。
CREATE INDEX idx_duty_runs_duty ON duty_runs(duty_id, started_at);
