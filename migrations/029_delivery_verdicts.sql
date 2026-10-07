-- 029 · 甲方的验收裁决:把「甲方认可了没有」从一句自我声明变成一行事实
--
-- ── 用户裁决(2026-10-08)────────────────────────────────────────
--
--   「只有甲方认可了之后,项目才算是结项,业务经理把交付物给到甲方之后,
--     项目进入『待收货』状态」
--
-- ── 它补的是什么:一道**假门** ──────────────────────────────────
--
-- 在这次改动之前,收口与交付这两道门的资格判据都是「存在 `status='accepted'`
-- 的 `deliverable` 工件」(`dispatcher.ts` 的 `close_finished_project` /
-- `handover_deliverable`)。而那个 `accepted` 是谁写的?**写它的人就是申请人自己**:
--
--   · `harness/system_prompts/project_manager.core.md` 逐字写着
--     「`status` 用 `accepted` —— 交付那一环的资格判据是「已验收的交付物」」;
--   · 真机库(`~/.sansheng/sansheng.db`,2026-10-08 实测)7 份 `deliverable`
--     **全部** `accepted`,作者是 `wk` / `pm` 自己;
--   · 平台三处注释自己承认这条路是死的(`tools/blackboard.ts` /
--     `runtime/dispatcher.ts`):「平台今天**没有任何地方**会把 `open` 改成
--     `accepted`」—— 把它当事实记着,没当缺陷修。
--
-- ⇒ 门的判据 = 申请人的自我声明。这正是本项目最警惕的形态(对照
-- `code_service` 的写入口:平台**当场去盘上核对**七件事,那才是真门)。
-- 后果不是「少一道校验」,是**收口(不可逆)建在一句没人核实的话上**:
-- 组织可以自己宣布「甲方验收了」,然后自己销号。
--
-- ⇒ 缺的那个事实是**甲方的裁决**。它有两个性质,决定了它的形状:
--
--   ① **不是一个角色能做的事**:模型不能替甲方拍板。所以它不是工具、不在任何
--      角色的 ceiling 里,而是**只有 HTTP 面**的一条写入口
--      (`POST /api/artifacts/:id/verdict`),与 `client-questions/:id/answer`
--      同一条纪律(那次答复也是由甲方点出来的)。
--   ② **可以改判、可以反复**:甲方今天说「要改」,作者返工后重交一版,甲方
--      可能说「可以了」。所以它是**追加式**的一行行记录,而不是工件上的一列 ——
--      只留最后一条等于改判现场消失(与 021 的 `review_verdicts` 同一条理由)。
--
-- ── 为什么不是给 `projects.status` 加一个 `awaiting_acceptance` 值 ──
--
-- 加一个取值要重建 `projects`(SQLite 的 CHECK 只能收紧不能放宽,见 015 的实测),
-- 而 `projects` 有 **14 张 ON DELETE CASCADE 的子表**(实测:
-- `PRAGMA foreign_key_list(<每张表>) where table='projects'`):
--   project_assignments · works · blockers · change_requests · asks · meetings ·
--   project_sessions · dispatch_attempts · dispatch_events · turn_usage ·
--   client_questions · review_verdicts · artifacts · knowledge_chunks
-- 026 已经用探针证明过这件事的代价:数据少的时候那种重建**不报错而静默清空子表**
-- (`.probe/026-rebuild-probe.mjs` 的 Q1/Q2)。为了一个**可以从这张表直接算出来**的
-- 显示状态去动 14 张表的级联,是把一个查询换成一次数据风险。
--
-- ⇒ 「待收货」是 `active` 项目上的一个**派生状态**,判据只有一条:
--   **存在「已交付(有交付会话)且没有裁决」的交付物**。它由
--   `transport/views.ts` 算一次给读面(`ProjectSummary.status` 的派生取值),
--   由 `runtime/dispatcher.ts` 算一次给规则(收口门),两处读的都是本表。
--
-- ── 与 `artifacts.status` 的分工(这次一定要说清,否则又是两个词打架)──
--
--   · `artifacts.status = 'accepted'` 从今天起的语义是 **「定稿」**(作者整合完了,
--     可以交给甲方了)—— 它仍然是模型写的,因为它表达的是**作者的自述**;
--   · `delivery_verdicts.verdict` 才是 **「甲方收不收」**,只有甲方能写。
--   ⇒ 收口门从此读的是后者。`open`→`accepted` 那条老路一个字没改(改它会让
--     存量库上「已定稿待交付」的交付物全部失格,而那是一次静默的语义迁移)。
CREATE TABLE IF NOT EXISTS delivery_verdicts (
  -- 单调自增,与 021 同一条理由:同一条交付物可能被裁决多次(拒收 → 返工 → 再交付
  -- → 再裁决),「最新那条」靠 (created_at, seq) 判定,而 created_at 可能并列。
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- ⚠️ **NO ACTION,不加 CASCADE**:删掉一份交付物不该抹掉「甲方对它的裁决」
  -- 这件事(与 021 的 `finding_artifact_id`、`asks.resolution_artifact_id` 同形)。
  -- 它是审计面的事实,不是那条工件的附庸。
  artifact_id  TEXT NOT NULL REFERENCES artifacts(id),
  -- 闭集。**不叫 status**:status 在 artifacts 上是「定稿了没有」,在 works 上是
  -- 「做完了没有」,这里问的是「甲方收不收」—— 复用同一个词会让三处语义打架。
  verdict      TEXT NOT NULL CHECK (verdict IN ('accept','reject')),
  -- 甲方写的那句话(拒收时「哪里不行」)。**它进返工任务正文**:甲方没有别的
  -- 落点能说清这句话,而模型读不到它就只能在「你被拒收了」这五个字上猜。
  note         TEXT,
  created_at   INTEGER NOT NULL
);

-- 判定的读面:「这份交付物最新一次裁决是什么」+「这个项目有哪些货在等裁决」。
-- 两条都按 (created_at DESC, seq DESC) 取首条。
CREATE INDEX IF NOT EXISTS idx_delivery_verdicts_artifact
  ON delivery_verdicts(artifact_id, created_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_verdicts_project
  ON delivery_verdicts(project_id, created_at DESC, seq DESC);

-- ⚠️ **它给 `artifacts` 增加了第 7 张引用子表**(021 之后是第 6 张,见 021 文件头
-- 那段账)。动作是 `NO ACTION`,处置方式与 `asks.resolution_artifact_id` /
-- `review_verdicts.finding_artifact_id` 同形 —— **将来若有第二次重建 `artifacts`,
-- 先把它置 NULL、重建后回填。**
-- 它同时也给 `projects` 增加了第 15 张 CASCADE 子表(见上面那段:这也是
-- 「不加 `projects.status` 取值」的一条旁证 —— 每加一张子表,那种重建就更贵一点)。
