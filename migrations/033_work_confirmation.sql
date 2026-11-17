-- D3(2026-11-17):工作项「待确认」—— 甲方确认开工之前不派工。
--
-- 机制(设计 docs/DESIGN-FRONTEND-UX.md v3 §4 D3 硬档):
--   · 项目经理拆解出的工作项 `confirmed_at` 为 NULL —— 派工门
--     (`runtime/execution.ts` 的 `checkRunnable` 与 `pendingWork.ts` 的
--     `myOpenWorks`)拒绝它们:确认之前一个 token 都不花;
--   · 甲方在对话页的「计划」卡上点「确认开工」→
--     `POST /api/projects/:id/works/confirm` 把当前所有未确认的非终态工作项
--     一次性写上 `confirmed_at`,排空器的下一次兜底轮询自然接手;
--   · 「要先调整」走既有对话:项目经理改清单(退役/重建工作项)之后,
--     新工作项同样是未确认的,甲方再确认一次。
--
-- ⚠️ 存量回填:本迁移之前的世界里「拆出来即派工」是唯一行为,存量工作项
-- **视作已确认**(confirmed_at = created_at)—— 否则一次升级会把所有
-- 在跑项目的活全部冻住,而那是一次升级事故,不是一个产品决定。
-- 纯加法:可空列、无 CHECK(与 022/030 同一条先例,取值域在读写两侧的 TS 里)。
ALTER TABLE works ADD COLUMN confirmed_at INTEGER;
UPDATE works SET confirmed_at = created_at WHERE confirmed_at IS NULL;
